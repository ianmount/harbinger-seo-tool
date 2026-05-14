import { z } from "zod"
import { callClaude, ClaudeApiError } from "@/lib/claude"
import { dfsCost, dfsItems, locationFields, runTool } from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const MarketInput = z.object({
  location_code: z.number().int(),
  location_name: z.string().min(1),
})

const Input = z.object({
  seed: z.string().min(1),
  location_code: z.number().int().optional(),
  location_name: z.string().optional(),
  language_code: z.string().default("en"),
  /** Optional city markets used as additional volume-scope chips. */
  city_markets: z.array(MarketInput).max(8).default([]),
  /** Per-source limit (suggestion / idea / related). */
  limit: z.number().int().min(1).max(700).default(200),
})

const QUESTION_PREFIXES = [
  "how",
  "what",
  "why",
  "where",
  "when",
  "who",
  "which",
  "can",
  "are",
  "is",
  "do",
  "does",
  "should",
  "will",
  "could",
  "would",
  "best",
]

const INTENT_LETTER: Record<string, "I" | "N" | "C" | "T"> = {
  informational: "I",
  navigational: "N",
  commercial: "C",
  transactional: "T",
}

export type MarketKey = "national" | `city:${number}`

export type SourceTag = "suggestion" | "idea" | "related"

export type MagicMarket = {
  key: MarketKey
  label: string
  location_code: number
  location_name: string
  is_national: boolean
}

export type MagicRow = {
  keyword: string
  source: SourceTag
  intent: "I" | "N" | "C" | "T" | null
  /** Search volume per market key. Falls back to Labs national volume. */
  volumes: Record<MarketKey, number | null>
  kd: number | null
  cpc: number | null
  competition_level: string | null
  /** Distinct SERP feature slugs from DFSEO `serp_info.serp_item_types`. */
  serp_features: string[]
  is_question: boolean
  cluster: string | null
}

export type MagicCluster = {
  label: string
  count: number
  keywords: string[]
}

export type MagicData = {
  seed: string
  markets: MagicMarket[]
  /** Counts for the match-mode tab strip. */
  counts: {
    all: number
    phrase: number
    related: number
    pasf: number
    questions: number
  }
  stats: {
    total: number
    avg_volume: number | null
    avg_kd: number | null
  }
  clusters: MagicCluster[]
  rows: MagicRow[]
  cluster_warning: string | null
}

type LabsItem = {
  keyword?: string
  keyword_info?: {
    search_volume?: number | null
    cpc?: number | null
    competition_level?: string | null
    serp_info?: {
      serp_item_types?: string[] | null
    } | null
  } | null
  keyword_properties?: {
    keyword_difficulty?: number | null
  } | null
  search_intent_info?: {
    main_intent?: string | null
  } | null
}

function nationalLocFields(input: z.infer<typeof Input>) {
  return locationFields(input)
}

function cityLocFields(market: z.infer<typeof MarketInput>, languageCode: string) {
  return {
    location_code: market.location_code,
    language_code: languageCode,
  }
}

function intentBodyForLocation(
  keywords: string[],
  input: z.infer<typeof Input>,
) {
  // search_intent only accepts language fields (not location).
  return [
    {
      keywords,
      ...(input.location_code
        ? { language_code: input.language_code }
        : { language_name: "English" }),
    },
  ]
}

function isQuestion(keyword: string): boolean {
  const first = keyword.trim().toLowerCase().split(/\s+/)[0]
  if (!first) return false
  return QUESTION_PREFIXES.includes(first)
}

function extractItems(envelope: unknown, source: SourceTag): MagicRow[] {
  const rows: MagicRow[] = []
  for (const raw of dfsItems<LabsItem>(envelope)) {
    if (!raw.keyword) continue
    const serpTypes = raw.keyword_info?.serp_info?.serp_item_types ?? []
    // De-dup within-row + canonicalize.
    const features = Array.from(new Set(serpTypes.filter(Boolean)))
    const inlineIntent = raw.search_intent_info?.main_intent ?? null
    const intent = inlineIntent ? INTENT_LETTER[inlineIntent] ?? null : null
    rows.push({
      keyword: raw.keyword,
      source,
      intent,
      volumes: { national: raw.keyword_info?.search_volume ?? null } as Record<
        MarketKey,
        number | null
      >,
      kd: raw.keyword_properties?.keyword_difficulty ?? null,
      cpc: raw.keyword_info?.cpc ?? null,
      competition_level: raw.keyword_info?.competition_level ?? null,
      serp_features: features,
      is_question: isQuestion(raw.keyword),
      cluster: null,
    })
  }
  return rows
}

// ─── Claude clustering ──────────────────────────────────────────────────────

const ClusterResponseSchema = z.object({
  clusters: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(40),
        keywords: z.array(z.string().trim().min(1)).min(1).max(500),
      }),
    )
    .min(1)
    .max(12),
})

function stripCodeFences(text: string): string {
  const t = text.trim()
  const m = t.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i)
  return m ? m[1].trim() : t
}

function extractJsonObject(text: string): string {
  const stripped = stripCodeFences(text)
  const first = stripped.indexOf("{")
  const last = stripped.lastIndexOf("}")
  if (first === -1 || last === -1 || last <= first) return stripped
  return stripped.slice(first, last + 1)
}

async function clusterKeywordsWithClaude(
  seed: string,
  rows: MagicRow[],
): Promise<{ clusters: MagicCluster[]; warning: string | null }> {
  // Cap the input we send to Claude. Pick top-volume keywords first so
  // long-tail noise doesn't displace the meaningful clusters.
  const CAP = 250
  const sorted = [...rows].sort(
    (a, b) => (b.volumes.national ?? 0) - (a.volumes.national ?? 0),
  )
  const sample = sorted.slice(0, CAP)
  const list = sample
    .map((r) => `- ${r.keyword}`)
    .join("\n")

  const system =
    "You are an SEO analyst grouping a seed keyword's expansions into topical clusters. Return JSON only — no prose, no code fences."
  const prompt = [
    `Seed: "${seed}"`,
    "",
    "Group the following keywords into 5–8 distinct, mutually-exclusive topical clusters.",
    "Each cluster label should be 1–3 lowercase words describing the theme (e.g. \"installation\", \"vs comparisons\", \"motorized\").",
    "Every keyword from the input MUST be assigned to exactly one cluster. Do not invent keywords.",
    "",
    "Output JSON shape:",
    `{ "clusters": [ { "label": "<theme>", "keywords": ["<kw1>", "<kw2>", ...] } ] }`,
    "",
    "Keywords:",
    list,
  ].join("\n")

  let text: string
  try {
    text = await callClaude(prompt, {
      model: "claude-opus-4-7",
      maxTokens: 4096,
      system,
    })
  } catch (err) {
    const msg = err instanceof ClaudeApiError ? err.message : "unknown"
    return { clusters: [], warning: `Clustering skipped: ${msg}` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(extractJsonObject(text))
  } catch (err) {
    return {
      clusters: [],
      warning: `Clustering JSON parse failed: ${err instanceof Error ? err.message : "unknown"}`,
    }
  }
  const result = ClusterResponseSchema.safeParse(parsed)
  if (!result.success) {
    return {
      clusters: [],
      warning: `Clustering response shape invalid: ${result.error.message}`,
    }
  }

  // Validate every cluster keyword actually exists in the sample we sent.
  // Claude occasionally paraphrases; those would silently drop from the
  // count. Drop unknowns and rebuild counts from the surviving members.
  const pool = new Set(sample.map((r) => r.keyword.toLowerCase()))
  const dedup = new Map<string, string[]>()
  let hallucinated = 0
  for (const c of result.data.clusters) {
    const label = c.label.toLowerCase()
    const arr = dedup.get(label) ?? []
    for (const kw of c.keywords) {
      const lc = kw.toLowerCase()
      if (pool.has(lc)) arr.push(lc)
      else hallucinated++
    }
    dedup.set(label, arr)
  }
  const clusters: MagicCluster[] = []
  for (const [label, keywords] of dedup) {
    if (keywords.length === 0) continue
    clusters.push({
      label,
      count: keywords.length,
      keywords: Array.from(new Set(keywords)),
    })
  }
  clusters.sort((a, b) => b.count - a.count)

  const warning =
    hallucinated > 0
      ? `Claude introduced ${hallucinated} keyword${hallucinated === 1 ? "" : "s"} not in the source list — they were dropped.`
      : null

  return { clusters, warning }
}

export async function POST(request: Request) {
  return runTool<typeof Input, MagicData>(request, Input, async (input, { dfs }) => {
    const nationalLoc = nationalLocFields(input)

    // ── Stage 1: parallel labs calls. Each emits `serp_info` so we can
    //    populate the SERP-features icons without a separate SERP call.
    //    `include_serp_info` flag enables `serp_item_types` per item.
    const suggestionsBody = [
      {
        keyword: input.seed,
        ...nationalLoc,
        include_serp_info: true,
        limit: input.limit,
      },
    ]
    const ideasBody = [
      {
        keywords: [input.seed],
        ...nationalLoc,
        include_serp_info: true,
        limit: input.limit,
      },
    ]
    const relatedBody = [
      {
        keyword: input.seed,
        ...nationalLoc,
        include_serp_info: true,
        limit: input.limit,
      },
    ]

    const [suggestionsEnv, ideasEnv, relatedEnv] = await Promise.all([
      dfs("/v3/dataforseo_labs/google/keyword_suggestions/live", suggestionsBody),
      dfs("/v3/dataforseo_labs/google/keyword_ideas/live", ideasBody),
      dfs("/v3/dataforseo_labs/google/related_keywords/live", relatedBody),
    ])

    // Merge — first source wins, but accumulate SERP feature data across sources.
    const rowsByKw = new Map<string, MagicRow>()
    const allSourced = [
      ...extractItems(suggestionsEnv, "suggestion"),
      ...extractItems(ideasEnv, "idea"),
      ...extractItems(relatedEnv, "related"),
    ]
    for (const row of allSourced) {
      const existing = rowsByKw.get(row.keyword)
      if (!existing) {
        rowsByKw.set(row.keyword, row)
        continue
      }
      // Merge SERP features across sources for the same keyword.
      const merged = new Set([...existing.serp_features, ...row.serp_features])
      existing.serp_features = Array.from(merged)
      // Backfill any missing fields from the duplicate row.
      existing.kd ??= row.kd
      existing.cpc ??= row.cpc
      existing.competition_level ??= row.competition_level
      existing.intent ??= row.intent
      if (
        existing.volumes.national == null &&
        row.volumes.national != null
      ) {
        existing.volumes.national = row.volumes.national
      }
    }
    const merged = Array.from(rowsByKw.values())

    // ── Stage 2: per-market Google Ads volume (national + each city).
    const adsKeywords = merged.slice(0, 1000).map((r) => r.keyword)
    const markets: MagicMarket[] = []
    const nationalLabel = input.location_name ?? "United States"
    const nationalCode = input.location_code ?? 2840
    markets.push({
      key: "national",
      label: "National",
      location_code: nationalCode,
      location_name: nationalLabel,
      is_national: true,
    })
    for (const c of input.city_markets) {
      markets.push({
        key: `city:${c.location_code}`,
        label: c.location_name.split(",")[0] ?? c.location_name,
        location_code: c.location_code,
        location_name: c.location_name,
        is_national: false,
      })
    }

    const adsEnvelopes: unknown[] = []
    if (adsKeywords.length > 0) {
      const adsCalls = markets.map((m) => {
        const body = [
          {
            keywords: adsKeywords,
            ...(m.is_national
              ? nationalLoc
              : cityLocFields(
                  { location_code: m.location_code, location_name: m.location_name },
                  input.language_code,
                )),
          },
        ]
        return dfs("/v3/keywords_data/google_ads/search_volume/live", body)
      })
      const results = await Promise.all(adsCalls)
      for (let i = 0; i < markets.length; i++) {
        const m = markets[i]
        const env = results[i]
        adsEnvelopes.push(env)
        for (const raw of dfsItems<{
          keyword?: string
          search_volume?: number | null
          cpc?: number | null
        }>(env)) {
          if (!raw.keyword) continue
          const row = rowsByKw.get(raw.keyword)
          if (!row) continue
          row.volumes[m.key] = raw.search_volume ?? null
          if (m.is_national) {
            // Prefer Ads CPC for national since it tends to be more accurate
            // than the Labs imputed value.
            if (raw.cpc != null) row.cpc = raw.cpc
          }
        }
      }
    }

    // ── Stage 3: search_intent for everything we have (in chunks of 1000).
    let intentEnv: unknown = null
    const intentKeywords = merged.map((r) => r.keyword).slice(0, 1000)
    if (intentKeywords.length > 0) {
      try {
        intentEnv = await dfs(
          "/v3/dataforseo_labs/google/search_intent/live",
          intentBodyForLocation(intentKeywords, input),
        )
        for (const raw of dfsItems<{
          keyword?: string
          keyword_intent?: { label?: string }
        }>(intentEnv)) {
          if (!raw.keyword || !raw.keyword_intent?.label) continue
          const row = rowsByKw.get(raw.keyword)
          if (!row) continue
          row.intent = INTENT_LETTER[raw.keyword_intent.label] ?? row.intent
        }
      } catch (err) {
        // Intent is auxiliary — keep the inline values we got from labs.
        console.warn("[keyword-magic] search_intent failed:", err)
      }
    }

    // ── Stage 4: clusters via Claude.
    const { clusters, warning: clusterWarning } = await clusterKeywordsWithClaude(
      input.seed,
      merged,
    )
    const clusterByKw = new Map<string, string>()
    for (const c of clusters) {
      for (const kw of c.keywords) clusterByKw.set(kw.toLowerCase(), c.label)
    }
    for (const row of merged) {
      row.cluster = clusterByKw.get(row.keyword.toLowerCase()) ?? null
    }

    // ── Tab counts + stats.
    const counts = {
      all: merged.length,
      phrase: merged.filter((r) => r.source === "suggestion").length,
      related: merged.filter((r) => r.source === "idea").length,
      pasf: merged.filter((r) => r.source === "related").length,
      questions: merged.filter((r) => r.is_question).length,
    }

    const volsForAvg: number[] = []
    const kdsForAvg: number[] = []
    for (const r of merged) {
      const v = r.volumes.national
      if (typeof v === "number") volsForAvg.push(v)
      if (typeof r.kd === "number") kdsForAvg.push(r.kd)
    }
    const avg = (xs: number[]) =>
      xs.length === 0 ? null : Math.round(xs.reduce((a, b) => a + b, 0) / xs.length)

    const stats = {
      total: merged.length,
      avg_volume: avg(volsForAvg),
      avg_kd: avg(kdsForAvg),
    }

    return {
      data: {
        seed: input.seed,
        markets,
        counts,
        stats,
        clusters,
        rows: merged,
        cluster_warning: clusterWarning,
      },
      endpoints: [
        "/v3/dataforseo_labs/google/keyword_suggestions/live",
        "/v3/dataforseo_labs/google/keyword_ideas/live",
        "/v3/dataforseo_labs/google/related_keywords/live",
        "/v3/keywords_data/google_ads/search_volume/live",
        ...(intentEnv ? ["/v3/dataforseo_labs/google/search_intent/live"] : []),
      ],
      costUsd: dfsCost(suggestionsEnv, ideasEnv, relatedEnv, ...adsEnvelopes, intentEnv),
    }
  })
}
