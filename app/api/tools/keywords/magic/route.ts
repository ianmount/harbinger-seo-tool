import { z } from "zod"
import {
  dfsCost,
  dfsItems,
  dfsResultItems,
  locationFields,
  runTool,
} from "@/lib/tool-route"

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
  /** Count of keywords DFSEO returned a non-null search_volume for in
   *  this market. Surfaces in the UI as a coverage chip so you can
   *  verify city-level data is actually different from national. */
  coverage: number
  /** Total keywords queried for this market (same across markets within
   *  a run, but useful for the "47 / 220" label form). */
  queried: number
}

export type MagicRow = {
  keyword: string
  source: SourceTag
  intent: "I" | "N" | "C" | "T" | null
  /** Per-market Google Ads search volume. National is keyed `national`,
   *  cities are keyed `city:${location_code}`. `undefined` means the
   *  market wasn't queried; `null` means the market was queried but the
   *  keyword returned no volume row. */
  volumes: Record<MarketKey, number | null>
  kd: number | null
  cpc: number | null
  competition_level: string | null
  /** Distinct SERP feature slugs from DFSEO Labs `serp_info.serp_item_types`. */
  serp_features: string[]
  is_question: boolean
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
  rows: MagicRow[]
}

/**
 * Canonicalised shape of a single Labs item after unwrapping the
 * `related_keywords` envelope. `keyword_suggestions` and `keyword_ideas`
 * return flat items; `related_keywords` nests the keyword data under
 * `keyword_data` (the parent item itself only carries `depth` and the
 * `related_keywords` string array). We normalise both into the same
 * shape so the downstream extractor doesn't care which source it came
 * from.
 */
type CanonicalLabsItem = {
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
  // Labs returns `serp_info` as a TOP-LEVEL sibling of `keyword_info`,
  // even when `include_serp_info: true`. Keep `keyword_info.serp_info`
  // as a fallback because some snapshot variants nest it.
  serp_info?: {
    serp_item_types?: string[] | null
  } | null
  search_intent_info?: {
    main_intent?: string | null
  } | null
}

type RelatedKeywordsItem = {
  depth?: number
  related_keywords?: string[] | null
  keyword_data?: CanonicalLabsItem | null
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

function canonicalise(
  raw: CanonicalLabsItem | RelatedKeywordsItem,
  source: SourceTag,
): CanonicalLabsItem | null {
  if (source === "related") {
    const kd = (raw as RelatedKeywordsItem).keyword_data
    return kd ?? null
  }
  return raw as CanonicalLabsItem
}

function extractItems(envelope: unknown, source: SourceTag): MagicRow[] {
  const rows: MagicRow[] = []
  for (const raw of dfsItems<CanonicalLabsItem | RelatedKeywordsItem>(
    envelope,
  )) {
    const item = canonicalise(raw, source)
    if (!item?.keyword) continue
    // Prefer top-level `serp_info` (the documented shape) and fall back
    // to the nested `keyword_info.serp_info` for older snapshots.
    const serpTypes =
      item.serp_info?.serp_item_types ??
      item.keyword_info?.serp_info?.serp_item_types ??
      []
    const features = Array.from(new Set(serpTypes.filter(Boolean)))
    const inlineIntent = item.search_intent_info?.main_intent ?? null
    const intent = inlineIntent ? INTENT_LETTER[inlineIntent] ?? null : null
    rows.push({
      keyword: item.keyword,
      source,
      intent,
      volumes: {
        national: item.keyword_info?.search_volume ?? null,
      } as Record<MarketKey, number | null>,
      kd: item.keyword_properties?.keyword_difficulty ?? null,
      cpc: item.keyword_info?.cpc ?? null,
      competition_level: item.keyword_info?.competition_level ?? null,
      serp_features: features,
      is_question: isQuestion(item.keyword),
    })
  }
  return rows
}

export async function POST(request: Request) {
  return runTool<typeof Input, MagicData>(request, Input, async (input, { dfs }) => {
    const nationalLoc = nationalLocFields(input)

    // ── Stage 1: parallel labs calls. Each emits `serp_info` so we can
    //    populate the SERP-features icons without a separate SERP call.
    //    `include_serp_info` is the documented flag on every Labs
    //    keyword endpoint.
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
      coverage: 0,
      queried: 0,
    })
    for (const c of input.city_markets) {
      markets.push({
        key: `city:${c.location_code}`,
        label: c.location_name.split(",")[0] ?? c.location_name,
        location_code: c.location_code,
        location_name: c.location_name,
        is_national: false,
        coverage: 0,
        queried: 0,
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
      // Pre-mark every queried market as `null` on every row so the UI
      // can tell "queried, no data" apart from "never queried" via
      // hasOwnProperty. Without this, a city that returned no row for a
      // given keyword would have `undefined` and the UI would silently
      // fall through to the next defined value.
      for (let i = 0; i < markets.length; i++) {
        const m = markets[i]
        for (const row of merged) {
          if (!(m.key in row.volumes)) row.volumes[m.key] = null
        }
        const env = results[i]
        adsEnvelopes.push(env)
        let coverage = 0
        // google_ads/search_volume returns rows DIRECTLY in
        // tasks[0].result (no `.items` wrapper, unlike Labs endpoints).
        // Using dfsItems() here silently yields nothing — that's what
        // had the coverage chips reading 0 on every market.
        for (const raw of dfsResultItems<{
          keyword?: string
          search_volume?: number | null
          cpc?: number | null
        }>(env)) {
          if (!raw.keyword) continue
          const row = rowsByKw.get(raw.keyword)
          if (!row) continue
          row.volumes[m.key] = raw.search_volume ?? null
          if (raw.search_volume != null) coverage++
          if (m.is_national && raw.cpc != null) {
            // Prefer Ads CPC for national since it tends to be more
            // accurate than the Labs imputed value.
            row.cpc = raw.cpc
          }
        }
        m.coverage = coverage
        m.queried = adsKeywords.length
        console.log(
          `[keyword-magic] ads volume: market=${m.label} code=${m.location_code} keywords=${adsKeywords.length} with-volume=${coverage}`,
        )
      }
    }

    // ── Stage 3: search_intent for everything we have (cap 1000/call).
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

    // One-time visibility check that SERP features actually came through.
    const withFeatures = merged.filter((r) => r.serp_features.length > 0).length
    console.log(
      `[keyword-magic] rows=${merged.length} with-serp-features=${withFeatures}`,
    )

    return {
      data: {
        seed: input.seed,
        markets,
        counts,
        stats,
        rows: merged,
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
