import { z } from "zod"
import {
  dfsCost,
  dfsItems,
  locationFields,
  runTool,
} from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const Input = z.object({
  seed_keywords: z.array(z.string().min(1)).min(1).max(10),
  location_code: z.number().int().optional(),
  location_name: z.string().optional(),
  language_code: z.string().default("en"),
  /** How many top-volume candidates feed Stage 2 PAA harvest. */
  paa_top_n: z.number().int().min(1).max(100).default(30),
})

type Input = z.infer<typeof Input>

const QUESTION_REGEX =
  "^(who|what|where|when|why|how|can|does|is|are|do|should|will|could|would|which)\\s"

const INTENT_LETTER: Record<string, "I" | "N" | "C" | "T"> = {
  informational: "I",
  navigational: "N",
  commercial: "C",
  transactional: "T",
}

export type FaqStageCounts = {
  /** Distinct (seed, source) keyword rows returned by Stage 1 before dedupe. */
  candidates_raw: number
  /** Distinct candidate keywords after lower-case dedupe across seeds + sources. */
  candidates_deduped: number
  /** Selected for Stage 2 PAA harvest. */
  paa_seeds: number
  /** Raw PAA items extracted (pre-dedupe). */
  paa_raw: number
  /** Deduped canonical questions before enrichment. */
  deduped_questions: number
  /** Final ranked FAQ rows. */
  final_faqs: number
}

export type FaqSource = {
  url: string
  domain: string
}

export type RankedFaq = {
  question: string
  score: number
  /** How many distinct seeds surfaced this question. */
  frequency: number
  search_volume: number | null
  cpc: number | null
  competition_level: string | null
  intent: "I" | "N" | "C" | "T" | null
  triggered_by: string[]
  top_sources: FaqSource[]
  answer_snippets: string[]
}

export type FaqData = {
  seeds: string[]
  location: {
    location_code: number | null
    location_name: string
    language_code: string
  }
  counts: FaqStageCounts
  /**
   * Stage 1 candidates that fed Stage 2 (top N by search volume + the
   * original seeds). Surfaced for the UI's "PAA harvest" stage card so
   * the user can see exactly which keywords were SERP'd.
   */
  paa_seed_keywords: { keyword: string; search_volume: number | null }[]
  ranked: RankedFaq[]
}

// ─── Stage 1: candidate harvest ────────────────────────────────────────────

type CandidateRow = {
  keyword: string
  search_volume: number | null
  cpc: number | null
  competition_level: string | null
  /** Which seed(s) surfaced this candidate. */
  triggered_by: Set<string>
}

type SuggestionItem = {
  keyword?: string
  keyword_info?: {
    search_volume?: number | null
    cpc?: number | null
    competition_level?: string | null
  } | null
}

type RelatedItem = {
  keyword_data?: {
    keyword?: string
    keyword_info?: {
      search_volume?: number | null
      cpc?: number | null
      competition_level?: string | null
    } | null
  } | null
}

function locFieldsFor(input: Input): Record<string, string | number> {
  return locationFields(input)
}

function mergeCandidate(
  map: Map<string, CandidateRow>,
  keyword: string,
  seed: string,
  raw: SuggestionItem["keyword_info"] | null | undefined,
) {
  const key = keyword.toLowerCase().trim()
  if (!key) return
  const existing = map.get(key)
  if (existing) {
    existing.triggered_by.add(seed)
    if (existing.search_volume == null && raw?.search_volume != null) {
      existing.search_volume = raw.search_volume
    }
    if (existing.cpc == null && raw?.cpc != null) existing.cpc = raw.cpc
    if (existing.competition_level == null && raw?.competition_level) {
      existing.competition_level = raw.competition_level
    }
    return
  }
  map.set(key, {
    keyword,
    search_volume: raw?.search_volume ?? null,
    cpc: raw?.cpc ?? null,
    competition_level: raw?.competition_level ?? null,
    triggered_by: new Set([seed]),
  })
}

// ─── Stage 2: PAA recursion ────────────────────────────────────────────────

type PaaRow = {
  question: string
  answer_snippet: string | null
  source_url: string | null
  source_domain: string | null
  triggered_by_keyword: string
}

type SerpItem = {
  type?: string
  title?: string
  question?: string
  items?: SerpItem[]
  expanded_element?: SerpItem[]
  description?: string
  snippet?: string
  url?: string
  domain?: string
}

function collectPaa(
  items: SerpItem[] | undefined,
  triggeredBy: string,
  out: PaaRow[],
) {
  if (!items) return
  for (const item of items) {
    // A people_also_ask block wraps people_also_ask_element entries.
    if (item.type === "people_also_ask") {
      collectPaa(item.items, triggeredBy, out)
      continue
    }
    // A people_also_ask_element is one Q. Its expanded_element holds the
    // (single) Google-cited answer block with url/domain/description.
    if (
      item.type === "people_also_ask_element" ||
      item.type === "people_also_ask_expanded_element"
    ) {
      const question = (item.title ?? item.question ?? "").trim()
      if (question) {
        const expanded = item.expanded_element?.[0]
        out.push({
          question,
          answer_snippet:
            expanded?.description?.trim() ?? item.description?.trim() ?? null,
          source_url: expanded?.url ?? item.url ?? null,
          source_domain: expanded?.domain ?? item.domain ?? null,
          triggered_by_keyword: triggeredBy,
        })
      }
      // PAA elements can themselves contain nested items when click_depth>1.
      collectPaa(item.items, triggeredBy, out)
      continue
    }
    // Walk into any other container that happens to have nested items —
    // belt-and-suspenders for schema drift.
    if (Array.isArray(item.items)) {
      collectPaa(item.items, triggeredBy, out)
    }
  }
}

// ─── Stage 3: dedupe + cluster ─────────────────────────────────────────────

function normalizeQuestion(q: string): string {
  return q
    .toLowerCase()
    .replace(/[?!.]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

type QuestionCluster = {
  canonical: string
  triggered_by: Set<string>
  source_urls: Map<string, string> // url -> domain
  answer_snippets: string[]
}

function chooseCanonical(prev: string, next: string): string {
  // Longest variant wins — tends to be the most descriptive phrasing.
  if (next.length > prev.length) return next
  return prev
}

// ─── Stage 4: enrichment helpers ───────────────────────────────────────────

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

type OverviewItem = {
  keyword?: string
  keyword_info?: {
    search_volume?: number | null
    cpc?: number | null
    competition_level?: string | null
  } | null
  search_intent_info?: { main_intent?: string | null } | null
}

type IntentItem = {
  keyword?: string
  keyword_intent?: { label?: string | null } | null
}

// ─── Route handler ─────────────────────────────────────────────────────────

export async function POST(request: Request) {
  return runTool<typeof Input, FaqData>(request, Input, async (input, { dfs }) => {
    const seeds = Array.from(
      new Set(input.seed_keywords.map((s) => s.trim()).filter(Boolean)),
    )
    if (seeds.length === 0) {
      throw new Error("Provide at least one seed keyword.")
    }
    const loc = locFieldsFor(input)
    const envelopes: unknown[] = []
    const endpointsHit = new Set<string>()

    // ── Stage 1 ─────────────────────────────────────────────────────────
    const candidates = new Map<string, CandidateRow>()
    // Always include the seeds themselves — they're the highest-signal
    // PAA triggers and might not survive their own Labs filters.
    for (const seed of seeds) {
      mergeCandidate(candidates, seed, seed, null)
    }

    const stage1Calls = seeds.flatMap((seed) => [
      dfs("/v3/dataforseo_labs/google/keyword_suggestions/live", [
        {
          keyword: seed,
          ...loc,
          limit: 1000,
          filters: [
            ["keyword_info.search_volume", ">", 0],
            "and",
            ["keyword", "regex", QUESTION_REGEX],
          ],
          order_by: ["keyword_info.search_volume,desc"],
        },
      ]).then((env) => ({ kind: "suggestion" as const, seed, env })),
      dfs("/v3/dataforseo_labs/google/related_keywords/live", [
        {
          keyword: seed,
          ...loc,
          depth: 4,
          limit: 1000,
          filters: [
            ["keyword_data.keyword_info.search_volume", ">", 0],
            "and",
            ["keyword_data.keyword", "regex", QUESTION_REGEX],
          ],
          order_by: ["keyword_data.keyword_info.search_volume,desc"],
        },
      ]).then((env) => ({ kind: "related" as const, seed, env })),
    ])

    const stage1Results = await Promise.all(stage1Calls)
    let candidatesRaw = 0
    for (const r of stage1Results) {
      envelopes.push(r.env)
      if (r.kind === "suggestion") {
        endpointsHit.add("/v3/dataforseo_labs/google/keyword_suggestions/live")
        for (const raw of dfsItems<SuggestionItem>(r.env)) {
          if (!raw.keyword) continue
          candidatesRaw++
          mergeCandidate(candidates, raw.keyword, r.seed, raw.keyword_info)
        }
      } else {
        endpointsHit.add("/v3/dataforseo_labs/google/related_keywords/live")
        for (const raw of dfsItems<RelatedItem>(r.env)) {
          const kd = raw.keyword_data
          if (!kd?.keyword) continue
          candidatesRaw++
          mergeCandidate(candidates, kd.keyword, r.seed, kd.keyword_info)
        }
      }
    }

    // ── Stage 2: pick top N by volume + always include seeds ────────────
    const allCandidates = Array.from(candidates.values())
    const nonSeedSorted = allCandidates
      .filter((c) => !seeds.includes(c.keyword))
      .sort(
        (a, b) =>
          (b.search_volume ?? 0) - (a.search_volume ?? 0) ||
          a.keyword.localeCompare(b.keyword),
      )
    const paaSeedRows: { keyword: string; search_volume: number | null }[] = []
    const seen = new Set<string>()
    for (const seed of seeds) {
      const lower = seed.toLowerCase()
      if (seen.has(lower)) continue
      seen.add(lower)
      const row = candidates.get(lower)
      paaSeedRows.push({ keyword: seed, search_volume: row?.search_volume ?? null })
    }
    for (const c of nonSeedSorted) {
      if (paaSeedRows.length >= input.paa_top_n + seeds.length) break
      const lower = c.keyword.toLowerCase()
      if (seen.has(lower)) continue
      seen.add(lower)
      paaSeedRows.push({ keyword: c.keyword, search_volume: c.search_volume })
    }

    const rawPaa: PaaRow[] = []
    const serpCalls = paaSeedRows.map((row) =>
      dfs(
        "/v3/serp/google/organic/live/advanced",
        [
          {
            keyword: row.keyword,
            ...loc,
            depth: 10,
            people_also_ask_click_depth: 4,
          },
        ],
        { timeoutMs: 120_000 },
      ).catch((err) => {
        // One bad SERP shouldn't kill the whole run — PAA harvest is
        // best-effort and we'd rather return partial results.
        console.warn(
          `[faq-research] SERP failed for "${row.keyword}":`,
          err instanceof Error ? err.message : err,
        )
        return null
      }),
    )
    const serpResults = await Promise.all(serpCalls)
    endpointsHit.add("/v3/serp/google/organic/live/advanced")
    for (let i = 0; i < paaSeedRows.length; i++) {
      const env = serpResults[i]
      if (env == null) continue
      envelopes.push(env)
      const triggeredBy = paaSeedRows[i].keyword
      const items = ((env as {
        tasks?: { result?: ({ items?: SerpItem[] } | null)[] | null }[]
      })?.tasks?.[0]?.result?.[0]?.items ?? []) as SerpItem[]
      collectPaa(items, triggeredBy, rawPaa)
    }

    // ── Stage 3: dedupe + cluster ───────────────────────────────────────
    const clusters = new Map<string, QuestionCluster>()
    for (const row of rawPaa) {
      const key = normalizeQuestion(row.question)
      if (!key) continue
      let cluster = clusters.get(key)
      if (!cluster) {
        cluster = {
          canonical: row.question,
          triggered_by: new Set(),
          source_urls: new Map(),
          answer_snippets: [],
        }
        clusters.set(key, cluster)
      } else {
        cluster.canonical = chooseCanonical(cluster.canonical, row.question)
      }
      cluster.triggered_by.add(row.triggered_by_keyword)
      if (row.source_url && !cluster.source_urls.has(row.source_url)) {
        cluster.source_urls.set(row.source_url, row.source_domain ?? "")
      }
      if (
        row.answer_snippet &&
        cluster.answer_snippets.length < 2 &&
        !cluster.answer_snippets.includes(row.answer_snippet)
      ) {
        cluster.answer_snippets.push(row.answer_snippet)
      }
    }

    // ── Stage 4: enrich + rank ──────────────────────────────────────────
    const dedupedQuestions = Array.from(clusters.entries()).map(([key, c]) => ({
      key,
      ...c,
    }))

    // Batch keyword_overview in chunks of 700.
    const overviewByKw = new Map<string, OverviewItem>()
    const intentByKw = new Map<string, "I" | "N" | "C" | "T">()
    const overviewKeywords = dedupedQuestions.map((q) => q.canonical)
    if (overviewKeywords.length > 0) {
      const overviewChunks = chunk(overviewKeywords, 700)
      const overviewCalls = overviewChunks.map((kws) =>
        dfs("/v3/dataforseo_labs/google/keyword_overview/live", [
          { keywords: kws, ...loc, include_serp_info: false },
        ]).catch((err) => {
          console.warn(
            "[faq-research] keyword_overview chunk failed:",
            err instanceof Error ? err.message : err,
          )
          return null
        }),
      )
      const overviewResults = await Promise.all(overviewCalls)
      endpointsHit.add("/v3/dataforseo_labs/google/keyword_overview/live")
      for (const env of overviewResults) {
        if (env == null) continue
        envelopes.push(env)
        for (const raw of dfsItems<OverviewItem>(env)) {
          if (!raw.keyword) continue
          overviewByKw.set(raw.keyword.toLowerCase(), raw)
          const inline = raw.search_intent_info?.main_intent
          if (inline) {
            const letter = INTENT_LETTER[inline]
            if (letter) intentByKw.set(raw.keyword.toLowerCase(), letter)
          }
        }
      }

      // Polish: explicit search_intent call for anything overview didn't
      // surface an intent for. search_intent uses language-only params.
      const missingIntent = overviewKeywords.filter(
        (kw) => !intentByKw.has(kw.toLowerCase()),
      )
      if (missingIntent.length > 0) {
        const intentChunks = chunk(missingIntent, 1000)
        const intentCalls = intentChunks.map((kws) =>
          dfs("/v3/dataforseo_labs/google/search_intent/live", [
            {
              keywords: kws,
              ...(input.location_code
                ? { language_code: input.language_code }
                : { language_name: "English" }),
            },
          ]).catch((err) => {
            console.warn(
              "[faq-research] search_intent chunk failed:",
              err instanceof Error ? err.message : err,
            )
            return null
          }),
        )
        const intentResults = await Promise.all(intentCalls)
        endpointsHit.add("/v3/dataforseo_labs/google/search_intent/live")
        for (const env of intentResults) {
          if (env == null) continue
          envelopes.push(env)
          for (const raw of dfsItems<IntentItem>(env)) {
            const label = raw.keyword_intent?.label
            if (!raw.keyword || !label) continue
            const letter = INTENT_LETTER[label]
            if (letter) intentByKw.set(raw.keyword.toLowerCase(), letter)
          }
        }
      }
    }

    // Compose final ranked rows.
    const ranked: RankedFaq[] = dedupedQuestions.map((q) => {
      const ov = overviewByKw.get(q.canonical.toLowerCase()) ?? null
      const sv = ov?.keyword_info?.search_volume ?? null
      const frequency = q.triggered_by.size
      const score = Math.round(
        frequency * 10 + Math.log((sv ?? 0) + 1) * 5,
      )
      const sources: FaqSource[] = Array.from(q.source_urls.entries())
        .slice(0, 5)
        .map(([url, domain]) => ({ url, domain }))
      return {
        question: q.canonical,
        score,
        frequency,
        search_volume: sv,
        cpc: ov?.keyword_info?.cpc ?? null,
        competition_level: ov?.keyword_info?.competition_level ?? null,
        intent: intentByKw.get(q.canonical.toLowerCase()) ?? null,
        triggered_by: Array.from(q.triggered_by).sort(),
        top_sources: sources,
        answer_snippets: q.answer_snippets,
      }
    })
    ranked.sort((a, b) => b.score - a.score || a.question.localeCompare(b.question))

    const counts: FaqStageCounts = {
      candidates_raw: candidatesRaw,
      candidates_deduped: candidates.size,
      paa_seeds: paaSeedRows.length,
      paa_raw: rawPaa.length,
      deduped_questions: clusters.size,
      final_faqs: ranked.length,
    }

    console.log(
      `[faq-research] seeds=${seeds.length} candidates_raw=${counts.candidates_raw} ` +
        `candidates_deduped=${counts.candidates_deduped} paa_seeds=${counts.paa_seeds} ` +
        `paa_raw=${counts.paa_raw} deduped=${counts.deduped_questions} ` +
        `final=${counts.final_faqs}`,
    )

    return {
      data: {
        seeds,
        location: {
          location_code: input.location_code ?? null,
          location_name:
            input.location_name ??
            (input.location_code ? `code:${input.location_code}` : "United States"),
          language_code: input.language_code,
        },
        counts,
        paa_seed_keywords: paaSeedRows,
        ranked,
      },
      endpoints: Array.from(endpointsHit),
      costUsd: dfsCost(...envelopes),
    }
  })
}

