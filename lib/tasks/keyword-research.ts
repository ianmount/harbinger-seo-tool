import "server-only"
import { z } from "zod"
import { createCostAccumulator, withAuditCost } from "@/lib/audit-cost"
import { callClaude, ClaudeApiError } from "@/lib/claude"
import {
  bulkKeywordDifficulty,
  competitorsDomain,
  DFS_LABS_COUNTRY_CODE_US,
  keywordIdeasMulti,
  rankedKeywords,
  relatedKeywords,
  searchIntent,
  searchVolume,
  serpTaskGet,
  serpTaskPost,
  serpTasksReady,
  type SearchIntent,
} from "@/lib/dataforseo"
import type { TaskRunner } from "@/lib/inngest/functions"
import {
  isCancelRequested,
  JobCancelledError,
  updateProgress,
} from "@/lib/jobs"
import type {
  CompetitionLevel,
  DfsLabsLocation,
  DfsLocation,
} from "@/lib/types"

/**
 * Keyword Research task. Replaces the old synchronous /keyword-research
 * page flow with a four-phase background job:
 *
 *   Phase 1 — National data sweep (parallel). competitors_domain →
 *     ranked_keywords ×N (partner + competitors), keyword_ideas (from
 *     services), related_keywords (per service). Once the keyword union
 *     is deduped, fan out bulk_keyword_difficulty + search_volume +
 *     search_intent in parallel.
 *
 *   Phase 2 — Claude shortlist. Sends merged per-keyword rows + the
 *     user's selected `max_keywords` to Claude; expects an array of
 *     exactly `max_keywords` keyword strings. Truncated server-side if
 *     Claude over-returns.
 *
 *   Phase 3 — City SERP probes (async standard queue). One task per
 *     (keyword × city) submitted in batches of 100, polled on
 *     `tasks_ready` every 15s up to ~10 min, then fetched via
 *     task_get/advanced. Records partner_position, top competitor
 *     positions, and SERP features per (keyword, city). Returns partial
 *     results if the queue isn't done before the timeout.
 *
 *   Phase 4 — Output assembly. Per the user's spec the output schema is
 *     unchanged from the legacy tab: per-city tabs, each with
 *     KeywordRow[] (keyword / volume / cpc / competition_level /
 *     currentRanking). No extra Claude synthesis — just merge Phase 1
 *     stats with Phase 3 partner positions.
 */

// ── Input ──────────────────────────────────────────────────────────────────

const dfsLocationSchema = z.object({
  location_code: z.number().int().positive(),
  location_name: z.string().min(1),
  location_code_parent: z.number().int().positive().nullable(),
  country_iso_code: z.string().nullable(),
  location_type: z.string().min(1),
})

export const KeywordResearchInputSchema = z.object({
  domain: z.string().min(3).max(200),
  services: z.array(z.string().min(1).max(120)).min(1).max(20),
  cities: z.array(dfsLocationSchema).min(1).max(10),
  maxKeywords: z.number().int().min(10).max(100),
})

export type KeywordResearchInput = z.infer<typeof KeywordResearchInputSchema>

// ── Output ─────────────────────────────────────────────────────────────────

export interface KeywordRow {
  keyword: string
  search_volume?: number
  cpc?: number
  competition?: number
  competition_level?: CompetitionLevel
  keyword_difficulty?: number
  intent?: SearchIntent
  /** Partner's SERP position in this city (1-indexed). Undefined if not in top 20. */
  currentRanking?: number
}

export interface CityResult {
  location: DfsLabsLocation
  rows: KeywordRow[]
  /** True when SERP probes failed/timed-out for this city; rows still render volume etc. */
  rankProbeFailed: boolean
  /** Number of (keyword × this city) probes that didn't return a SERP before the poll timeout. */
  unprobedKeywords: number
}

export interface KeywordResearchResult {
  domain: string
  services: string[]
  competitors: string[]
  cities: CityResult[]
  shortlist: string[]
  shortlistRationale: string
  costUsd: number
  durationSeconds: number
  warnings: string[]
}

// ── Internals ──────────────────────────────────────────────────────────────

const MODEL = "claude-sonnet-4-6"
const SERP_DEPTH = 20
const SERP_POLL_INTERVAL_MS = 15_000
const SERP_POLL_TIMEOUT_MS = 10 * 60_000 // 10 minutes
const MIN_RANKED_KEYWORDS_VOLUME = 50
const RANKED_KEYWORDS_LIMIT = 500
const KEYWORD_IDEAS_LIMIT = 200
const RELATED_KEYWORDS_LIMIT = 100
const COMPETITOR_LIMIT = 5

type StatRow = {
  keyword: string
  search_volume?: number
  cpc?: number
  competition?: number
  competition_level?: CompetitionLevel
  keyword_difficulty?: number
  intent?: SearchIntent
  partnerPosition: number | null
  competitorGap: boolean
  isQuickWin: boolean
}

function stripDomain(domain: string): string {
  return domain
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase()
}

const COUNTRY_LOC: DfsLocation = { code: DFS_LABS_COUNTRY_CODE_US }

async function loadCompetitors(
  domain: string,
  warnings: string[],
): Promise<string[]> {
  try {
    const rows = await competitorsDomain(domain, COUNTRY_LOC, {
      limit: COMPETITOR_LIMIT,
    })
    return rows.map((r) => stripDomain(r.domain)).filter(Boolean)
  } catch (err) {
    warnings.push(
      `Competitor discovery failed: ${err instanceof Error ? err.message : "unknown"}. Continuing without competitor data.`,
    )
    return []
  }
}

interface RankedRow {
  keyword: string
  position: number
  searchVolume: number
}

async function loadDomainRankings(
  target: string,
  warnings: string[],
  context: string,
): Promise<RankedRow[]> {
  try {
    const rows = await rankedKeywords(target, COUNTRY_LOC, {
      limit: RANKED_KEYWORDS_LIMIT,
      minVolume: MIN_RANKED_KEYWORDS_VOLUME,
    })
    return rows.map((r) => ({
      keyword: r.keyword,
      position: r.position,
      searchVolume: r.searchVolume,
    }))
  } catch (err) {
    warnings.push(
      `${context} ranked_keywords failed: ${err instanceof Error ? err.message : "unknown"}.`,
    )
    return []
  }
}

async function loadKeywordIdeas(
  services: string[],
  warnings: string[],
): Promise<string[]> {
  try {
    const rows = await keywordIdeasMulti(services, COUNTRY_LOC, {
      limit: KEYWORD_IDEAS_LIMIT,
    })
    return rows.map((r) => r.keyword)
  } catch (err) {
    warnings.push(
      `keyword_ideas failed: ${err instanceof Error ? err.message : "unknown"}.`,
    )
    return []
  }
}

async function loadRelatedKeywords(
  services: string[],
  warnings: string[],
): Promise<string[]> {
  // One call per service. Settled-all so a single failure doesn't drop the
  // whole bucket; record warnings per-failure.
  const settled = await Promise.allSettled(
    services.map((s) =>
      relatedKeywords(s, COUNTRY_LOC, { limit: RELATED_KEYWORDS_LIMIT }),
    ),
  )
  const out: string[] = []
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") {
      for (const kw of r.value) out.push(kw.keyword)
    } else {
      warnings.push(
        `related_keywords for "${services[i]}" failed: ${
          r.reason instanceof Error ? r.reason.message : String(r.reason)
        }`,
      )
    }
  })
  return out
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of values) {
    const k = v.trim().toLowerCase()
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(v.trim())
  }
  return out
}

function buildShortlistPrompt(
  rows: StatRow[],
  maxKeywords: number,
): { system: string; prompt: string } {
  const system =
    "You are an SEO strategist scoring local-service keyword candidates. Return only the JSON object the schema asks for — no markdown, no commentary."

  // Sort by a rough opportunity heuristic so the prompt's middle section
  // surfaces the strongest candidates first when Claude scans top-down.
  const ordered = rows.slice().sort((a, b) => {
    const av = a.search_volume ?? 0
    const bv = b.search_volume ?? 0
    return bv - av
  })

  const lines: string[] = []
  lines.push(`# Task`)
  lines.push(
    `Score and rank all keywords below, then select EXACTLY ${maxKeywords} keywords for city-level SERP checking.`,
  )
  lines.push("")
  lines.push(`## Scoring inputs (per keyword)`)
  lines.push(`- search_volume: monthly US searches (null/0 = no data).`)
  lines.push(`- difficulty: 0–100 keyword difficulty (lower = easier).`)
  lines.push(`- intent: informational | navigational | commercial | transactional.`)
  lines.push(
    `- partner_position: integer 1+ if partner ranks in DFS's top-N (volume >${MIN_RANKED_KEYWORDS_VOLUME}); null if partner doesn't show.`,
  )
  lines.push(
    `- competitor_gap: true if a competitor ranks 1–20 and partner is null or >20. High-priority signal.`,
  )
  lines.push(
    `- is_quick_win: true if partner_position is 11–30 (one tactical push could move them onto page 1).`,
  )
  lines.push("")
  lines.push(`## Shortlist composition (must satisfy ALL)`)
  lines.push(
    `1. Quick wins included where they exist — every keyword with is_quick_win=true that also has solid volume should appear.`,
  )
  lines.push(
    `2. Core service terms — terms that map directly to the partner's services (informational + commercial + transactional intent mix).`,
  )
  lines.push(
    `3. Location variants — include keywords that already carry geo modifiers ("plumber atlanta") if they're in the pool.`,
  )
  lines.push(
    `4. Mixed intent — at least 60% transactional/commercial; informational kept only when it fills a known content gap.`,
  )
  lines.push(
    `5. Drop branded keywords (mentioning the partner or competitor brand) and obvious duplicates.`,
  )
  lines.push("")
  lines.push(`## Output`)
  lines.push(
    `Return one JSON object: { "rationale": "<2–4 sentence summary of how you balanced the criteria>", "keywords": [<exactly ${maxKeywords} keyword strings, lowercase, no duplicates>] }.`,
  )
  lines.push("")
  lines.push(`## Candidates (${ordered.length} total)`)
  // Plain-text rows so Claude doesn't get tripped by oversized JSON. One
  // candidate per line; pipe-separated columns; bools as 0/1.
  for (const r of ordered) {
    const cols = [
      r.keyword,
      r.search_volume ?? "",
      r.keyword_difficulty ?? "",
      r.intent ?? "",
      r.partnerPosition ?? "",
      r.competitorGap ? 1 : 0,
      r.isQuickWin ? 1 : 0,
    ]
    lines.push(cols.join("|"))
  }
  return { system, prompt: lines.join("\n") }
}

const claudeShortlistResponseSchema = z.object({
  rationale: z.string().trim().min(1),
  keywords: z.array(z.string().trim().min(1)).min(1).max(120),
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

async function callClaudeShortlist(
  rows: StatRow[],
  maxKeywords: number,
): Promise<{ rationale: string; keywords: string[] }> {
  const { system, prompt } = buildShortlistPrompt(rows, maxKeywords)
  let text: string
  try {
    text = await callClaude(prompt, {
      model: MODEL,
      maxTokens: 4096,
      system,
    })
  } catch (err) {
    if (err instanceof ClaudeApiError) {
      throw new Error(`Claude shortlist failed: ${err.message}`)
    }
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(extractJsonObject(text))
  } catch (err) {
    throw new Error(
      `Claude returned invalid JSON: ${err instanceof Error ? err.message : "unknown"}`,
    )
  }
  const result = claudeShortlistResponseSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(`Claude response shape invalid: ${result.error.message}`)
  }
  // Dedupe (case-insensitive) and truncate to max.
  const seen = new Set<string>()
  const dedup: string[] = []
  for (const kw of result.data.keywords) {
    const k = kw.trim().toLowerCase()
    if (!k || seen.has(k)) continue
    seen.add(k)
    dedup.push(k)
    if (dedup.length >= maxKeywords) break
  }
  return { rationale: result.data.rationale, keywords: dedup }
}

// ── Phase 3: SERP probes ──────────────────────────────────────────────────

interface ProbeResult {
  /** Map keyword.toLowerCase() → partner SERP position (1-indexed). Missing = not in top 20 OR not probed. */
  positions: Map<string, number>
  /** Keywords whose task never came back ready before the poll timeout. */
  unprobedKeywords: string[]
  /** True iff all probes for this city failed/timed-out. */
  failed: boolean
}

async function probeCitySerps(
  jobId: string,
  shortlist: string[],
  city: DfsLabsLocation,
  partnerDomain: string,
  warnings: string[],
): Promise<ProbeResult> {
  if (shortlist.length === 0) {
    return { positions: new Map(), unprobedKeywords: [], failed: true }
  }
  const target = stripDomain(partnerDomain)

  // Submit tasks (batched at 100/POST inside serpTaskPost).
  let handles: Awaited<ReturnType<typeof serpTaskPost>>
  try {
    handles = await serpTaskPost(
      shortlist.map((kw) => ({
        keyword: kw,
        locationName: city.location_name,
        depth: SERP_DEPTH,
      })),
    )
  } catch (err) {
    warnings.push(
      `SERP task_post failed for ${city.location_name}: ${
        err instanceof Error ? err.message : "unknown"
      }`,
    )
    return {
      positions: new Map(),
      unprobedKeywords: shortlist.slice(),
      failed: true,
    }
  }
  const handlesById = new Map(handles.map((h) => [h.id, h]))

  // Poll tasks_ready until our submitted ids appear (or timeout).
  const collected = new Map<string, number>() // keyword → partner_position
  const fetchedIds = new Set<string>()
  const startedAt = Date.now()
  while (
    fetchedIds.size < handles.length &&
    Date.now() - startedAt < SERP_POLL_TIMEOUT_MS
  ) {
    if (await isCancelRequested(jobId)) {
      throw new JobCancelledError(jobId)
    }
    await new Promise((r) => setTimeout(r, SERP_POLL_INTERVAL_MS))
    let readyIds: string[] = []
    try {
      readyIds = await serpTasksReady()
    } catch (err) {
      warnings.push(
        `SERP tasks_ready poll failed for ${city.location_name}: ${
          err instanceof Error ? err.message : "unknown"
        } (will retry)`,
      )
      continue
    }
    const newlyReady = readyIds.filter(
      (id) => handlesById.has(id) && !fetchedIds.has(id),
    )
    // Fetch each newly-ready task. Done sequentially — DFS rate limits per
    // account, and the polling interval already paces things out.
    for (const id of newlyReady) {
      fetchedIds.add(id)
      try {
        const result = await serpTaskGet(id)
        const handle = handlesById.get(id)
        const kw = (handle?.keyword ?? result.keyword ?? "").toLowerCase()
        if (!kw) continue
        const partnerHit = result.organic.find(
          (o) => stripDomain(o.domain) === target,
        )
        if (partnerHit) collected.set(kw, partnerHit.position)
      } catch (err) {
        warnings.push(
          `SERP task_get failed (id=${id}): ${
            err instanceof Error ? err.message : "unknown"
          }`,
        )
      }
    }
  }

  // Anything not fetched by deadline → unprobed.
  const unprobed: string[] = []
  for (const h of handles) {
    if (!fetchedIds.has(h.id)) unprobed.push(h.keyword)
  }
  if (unprobed.length > 0) {
    warnings.push(
      `${city.location_name}: ${unprobed.length}/${handles.length} SERP probes did not return before the 10-minute timeout. Partial results shown.`,
    )
  }
  return {
    positions: collected,
    unprobedKeywords: unprobed,
    failed: handles.length === 0 || fetchedIds.size === 0,
  }
}

// ── Pipeline ───────────────────────────────────────────────────────────────

async function runKeywordResearchPipeline(
  jobId: string,
  input: KeywordResearchInput,
): Promise<{
  result: KeywordResearchResult
  resultPath: string
}> {
  const startedAt = Date.now()
  const warnings: string[] = []
  const cost = createCostAccumulator()

  const writeProgress = (stage: string, detail?: string) =>
    updateProgress(jobId, { stage, detail }).catch(() => {
      /* progress writes are best-effort */
    })

  const stage = async (label: string, detail?: string) => {
    await writeProgress(label, detail)
    if (await isCancelRequested(jobId)) throw new JobCancelledError(jobId)
  }

  const result = await withAuditCost(cost, async () => {
    const partnerDomain = stripDomain(input.domain)

    // ── Phase 1.0: discover competitors first (cheap, low-latency,
    // gates the parallel ranked_keywords fan-out below). ────────────
    await stage("Discovering competitors", `domain=${partnerDomain}`)
    const competitors = await loadCompetitors(partnerDomain, warnings)

    // ── Phase 1.1: parallel data sweep. ─────────────────────────────
    await stage(
      "Pulling rankings + ideas + related",
      `competitors=${competitors.length} services=${input.services.length}`,
    )
    const partnerRankPromise = loadDomainRankings(
      partnerDomain,
      warnings,
      "partner",
    )
    const competitorRankPromises = competitors.map((c) =>
      loadDomainRankings(c, warnings, `competitor:${c}`),
    )
    const ideasPromise = loadKeywordIdeas(input.services, warnings)
    const relatedPromise = loadRelatedKeywords(input.services, warnings)

    const [
      partnerRanks,
      competitorRanks,
      ideaKeywords,
      relatedKws,
    ] = await Promise.all([
      partnerRankPromise,
      Promise.all(competitorRankPromises),
      ideasPromise,
      relatedPromise,
    ])

    if (await isCancelRequested(jobId)) throw new JobCancelledError(jobId)

    // Build the deduped keyword universe from steps 2-5.
    const universe = dedupeStrings([
      ...partnerRanks.map((r) => r.keyword),
      ...competitorRanks.flat().map((r) => r.keyword),
      ...ideaKeywords,
      ...relatedKws,
    ])
    if (universe.length === 0) {
      throw new Error(
        "No keywords surfaced from any source. Check that the domain ranks for something or that the services list is non-empty.",
      )
    }

    // ── Phase 1.2: parallel difficulty + volume + intent. ───────────
    await stage(
      "Enriching with difficulty, volume, intent",
      `keywords=${universe.length}`,
    )
    const [diffRows, volRows, intentMap] = await Promise.all([
      bulkKeywordDifficulty(universe, COUNTRY_LOC).catch((err) => {
        warnings.push(
          `bulk_keyword_difficulty failed: ${err instanceof Error ? err.message : "unknown"}`,
        )
        return []
      }),
      searchVolume(universe, COUNTRY_LOC).catch((err) => {
        warnings.push(
          `search_volume failed: ${err instanceof Error ? err.message : "unknown"}`,
        )
        return []
      }),
      searchIntent(universe, COUNTRY_LOC).catch((err) => {
        warnings.push(
          `search_intent failed: ${err instanceof Error ? err.message : "unknown"}`,
        )
        return new Map<string, SearchIntent>()
      }),
    ])

    if (await isCancelRequested(jobId)) throw new JobCancelledError(jobId)

    // Merge into per-keyword stat rows.
    const diffByKw = new Map(
      diffRows.map((r) => [r.keyword.toLowerCase(), r.keyword_difficulty]),
    )
    const volByKw = new Map(
      volRows.map((r) => [
        r.keyword.toLowerCase(),
        {
          search_volume: r.search_volume,
          cpc: r.cpc,
          competition: r.competition,
          competition_level: r.competition_level,
        },
      ]),
    )
    const partnerPosByKw = new Map(
      partnerRanks.map((r) => [r.keyword.toLowerCase(), r.position]),
    )
    const competitorBestByKw = new Map<string, number>()
    for (const list of competitorRanks) {
      for (const r of list) {
        const k = r.keyword.toLowerCase()
        const prev = competitorBestByKw.get(k)
        if (prev == null || r.position < prev) competitorBestByKw.set(k, r.position)
      }
    }

    const statRows: StatRow[] = universe.map((kw) => {
      const k = kw.toLowerCase()
      const partnerPos = partnerPosByKw.get(k) ?? null
      const competitorBest = competitorBestByKw.get(k)
      const competitorGap =
        competitorBest != null &&
        competitorBest <= 20 &&
        (partnerPos == null || partnerPos > 20)
      const isQuickWin = partnerPos != null && partnerPos >= 11 && partnerPos <= 30
      const vol = volByKw.get(k)
      return {
        keyword: kw,
        search_volume: vol?.search_volume,
        cpc: vol?.cpc,
        competition: vol?.competition,
        competition_level: vol?.competition_level,
        keyword_difficulty: diffByKw.get(k) ?? undefined,
        intent: intentMap.get(k),
        partnerPosition: partnerPos,
        competitorGap,
        isQuickWin,
      }
    })

    // ── Phase 2: Claude shortlists max_keywords. ────────────────────
    await stage(
      "Asking Claude to shortlist",
      `pool=${statRows.length} target=${input.maxKeywords}`,
    )
    const { rationale, keywords: shortlistFromClaude } =
      await callClaudeShortlist(statRows, input.maxKeywords)
    const shortlist = shortlistFromClaude.slice(0, input.maxKeywords)
    if (shortlist.length === 0) {
      throw new Error("Claude returned an empty shortlist.")
    }

    if (await isCancelRequested(jobId)) throw new JobCancelledError(jobId)

    // ── Phase 3: SERP probes per (keyword × city). ──────────────────
    const probesByCity = new Map<string, ProbeResult>()
    for (const city of input.cities) {
      await stage(
        "Probing city SERPs",
        `${city.location_name} (${shortlist.length} keywords)`,
      )
      const probe = await probeCitySerps(
        jobId,
        shortlist,
        city,
        partnerDomain,
        warnings,
      )
      probesByCity.set(String(city.location_code), probe)
    }

    // Build per-keyword lookup for the merged stat rows.
    const statByKw = new Map(statRows.map((r) => [r.keyword.toLowerCase(), r]))

    // ── Phase 4: assemble per-city result tables. ───────────────────
    await stage("Assembling results")
    const cities: CityResult[] = input.cities.map((city) => {
      const probe =
        probesByCity.get(String(city.location_code)) ??
        ({
          positions: new Map(),
          unprobedKeywords: shortlist.slice(),
          failed: true,
        } satisfies ProbeResult)
      const rows: KeywordRow[] = shortlist.map((kw) => {
        const k = kw.toLowerCase()
        const stat = statByKw.get(k)
        return {
          keyword: kw,
          search_volume: stat?.search_volume,
          cpc: stat?.cpc,
          competition: stat?.competition,
          competition_level: stat?.competition_level,
          keyword_difficulty: stat?.keyword_difficulty,
          intent: stat?.intent,
          currentRanking: probe.positions.get(k),
        }
      })
      return {
        location: city,
        rows,
        rankProbeFailed: probe.failed,
        unprobedKeywords: probe.unprobedKeywords.length,
      }
    })

    return {
      domain: partnerDomain,
      services: input.services,
      competitors,
      cities,
      shortlist,
      shortlistRationale: rationale,
      costUsd: 0, // backfilled below
      durationSeconds: 0, // backfilled below
      warnings,
    } satisfies KeywordResearchResult
  })

  const totalCostUsd = cost.dataforseoUsd + cost.claudeUsd
  result.costUsd = Number(totalCostUsd.toFixed(4))
  result.durationSeconds = Math.round((Date.now() - startedAt) / 1000)

  console.log(
    `[keyword-research:done] job=${jobId} domain=${result.domain} cities=${result.cities.length} shortlist=${result.shortlist.length} duration=${result.durationSeconds}s cost=$${totalCostUsd.toFixed(2)}`,
  )

  return {
    result,
    resultPath: `/keyword-research/${jobId}`,
  }
}

export const runKeywordResearchTask: TaskRunner = async ({ jobId, job }) => {
  const parsed = KeywordResearchInputSchema.safeParse(job.input)
  if (!parsed.success) {
    throw new Error(
      `Invalid keyword research input: ${JSON.stringify(parsed.error.flatten())}`,
    )
  }
  return runKeywordResearchPipeline(jobId, parsed.data)
}
