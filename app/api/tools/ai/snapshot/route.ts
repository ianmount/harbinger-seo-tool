import { z } from "zod"
import { callClaude, ClaudeApiError } from "@/lib/claude"
import { listLabsLocations } from "@/lib/dataforseo"
import { dfsCost, dfsItems, dfsResultItems, runTool } from "@/lib/tool-route"
import type { DfsLabsLocation } from "@/lib/types"

export const dynamic = "force-dynamic"
export const maxDuration = 300

/**
 * AI Snapshot — single-shot prospect dashboard.
 *
 * Pipeline (see app/ai/snapshot/page.tsx for the build spec the dashboard
 * mirrors):
 *
 *   1. Resolve geo string → DFS location code/name.
 *   2. Generate ~50 candidate prompts via Claude (domain + geo).
 *   3. Score candidates via `ai_keyword_data/keywords_search_volume/live`;
 *      keep up to 25 with volume > 0.
 *   4. Parallel:
 *      - `llm_mentions/aggregated_metrics/live`  (target domain)
 *      - `llm_mentions/top_domains/live`         (5 representative prompts)
 *      - `llm_mentions/top_pages/live`           (5 representative prompts)
 *      - `llm_mentions/search/live`              (1 call per prompt, 25 total)
 *      - `serp/google/organic/live/advanced`     (1 call per prompt, 25 total)
 *      - `chat_gpt/llm_responses/live`           (3 calls — top-volume prompts)
 *   5. Derive competitors from top_domains, then run
 *      `llm_mentions/cross_aggregated_metrics/live` with target + 5 competitors.
 */

// ────────────────────────────────────────────────────────────────────────────
// Tunables.

const PROMPT_GENERATION_COUNT = 50
const KEPT_PROMPTS = 25
const SAMPLE_RESPONSES = 3
const COMPETITOR_COUNT = 5
const SNAPSHOT_MODEL = "claude-sonnet-4-6"
const SUGGESTION_KEYWORDS_FOR_RANKING = 5

// ────────────────────────────────────────────────────────────────────────────
// Input.

const Input = z.object({
  domain: z.string().min(1),
  /** DFS location_code chosen via LocationAutocomplete. Always present. */
  locationCode: z.number().int().positive(),
  /** Display-only name echoed back into the dashboard header. */
  locationName: z.string().min(1),
})

// ────────────────────────────────────────────────────────────────────────────
// Response shape — mirrors what the dashboard renders.

export type TopLine = {
  aiMentionRatePct: number | null
  totalMentions: number | null
  aiOverviewRatePct: number | null
  competitiveRank: { position: number; outOf: number } | null
}

export type PlatformBreakdown = {
  platform: string
  mentionPct: number | null
  promptsMentioned: number
  promptsTotal: number
}

export type CompetitorBar = {
  domain: string
  mentions: number
  isTarget: boolean
}

export type SampleResponse = {
  prompt: string
  responseText: string
  citations: string[]
  brandCited: boolean
}

export type PromptCoverageRow = {
  prompt: string
  aiSearchVolume: number | null
  platformsMentioned: Record<string, boolean>
  aiOverview: "cited" | "triggered" | "not-triggered"
}

export type SourceRow = { rank: number; value: string; count: number }

export type AiOverviewCard = {
  prompt: string
  brandCited: boolean
  overviewText: string
  citations: string[]
}

export type SnapshotData = {
  prospect: {
    domain: string
    geo: string
    promptCount: number
    llmCount: number
    runAt: string
    resolvedGeo: string
  }
  topLine: TopLine
  competitors: CompetitorBar[]
  platformBreakdown: PlatformBreakdown[]
  sampleResponses: SampleResponse[]
  promptCoverage: PromptCoverageRow[]
  topDomains: SourceRow[]
  topPages: SourceRow[]
  aiOverviewCards: AiOverviewCard[]
  warnings: string[]
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers.

function stripDomain(input: string): string {
  return input
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/+$/, "")
    .toLowerCase()
}

const KNOWN_LLM_KEYS = ["chat_gpt", "claude", "gemini", "perplexity"] as const
const LLM_DISPLAY: Record<string, string> = {
  chat_gpt: "ChatGPT",
  chatgpt: "ChatGPT",
  claude: "Claude",
  gemini: "Gemini",
  perplexity: "Perplexity",
}

function normalizeLlmKey(raw: string | null | undefined): string | null {
  if (!raw) return null
  const lower = raw.toLowerCase()
  if (lower.includes("chatgpt") || lower.includes("gpt") || lower.includes("openai"))
    return "chat_gpt"
  if (lower.includes("claude")) return "claude"
  if (lower.includes("gemini") || lower.includes("bard")) return "gemini"
  if (lower.includes("perplexity") || lower.includes("sonar")) return "perplexity"
  return null
}

function llmDisplayName(key: string): string {
  return LLM_DISPLAY[key] ?? key
}

/**
 * Look up a DataForSEO location row by its numeric `location_code`. The
 * client picker (LocationAutocomplete) hands us a validated code; we
 * round-trip through the cached locations list to recover the full row
 * (parent chain, location_type) needed for `resolveCountryFor`.
 */
async function lookupLocationByCode(
  code: number,
): Promise<DfsLabsLocation | null> {
  const all = await listLabsLocations("US")
  return all.find((l) => l.location_code === code) ?? null
}

/**
 * Build the `{ location_code, language_code }` pair used by every DFS endpoint
 * that takes geo here. Always emits `location_code` (not `location_name`)
 * because the AI Optimization endpoints reject `location_name` outright with
 * `40501 Invalid Field: 'location_name'` — they only accept `location_code`.
 *
 * Returns `null` when the geo string couldn't be resolved upstream; the
 * caller should surface a 400 in that case rather than silently dropping geo.
 */
function locationParams(
  loc: DfsLabsLocation | null,
): Record<string, string | number> | null {
  if (!loc) return null
  return {
    location_code: loc.location_code,
    language_code: "en",
  }
}

/**
 * Walk the DFS location's parent chain to the enclosing Country row. Used
 * by AI Optimization endpoints (specifically `keywords_search_volume`),
 * which only meaningfully accept country-level codes — passing a city code
 * yields a 40501 in some endpoints and zero results in others.
 */
async function resolveCountryFor(
  loc: DfsLabsLocation,
): Promise<DfsLabsLocation | null> {
  if (loc.location_type === "Country") return loc
  const all = await listLabsLocations(loc.country_iso_code ?? "US")
  const byCode = new Map(all.map((l) => [l.location_code, l]))
  let cursor: DfsLabsLocation | undefined = loc
  while (cursor && cursor.location_type !== "Country") {
    if (cursor.location_code_parent == null) break
    cursor = byCode.get(cursor.location_code_parent)
  }
  return cursor ?? null
}

/**
 * Ask Claude for a list of candidate prompts a buyer would plausibly ask an
 * LLM when searching for the kind of business behind `domain` in `geo`.
 * Returns the parsed string array; throws if the response isn't a valid JSON
 * array.
 */
async function generateCandidatePrompts(
  domain: string,
  geo: string,
): Promise<string[]> {
  const prompt = `You are generating a candidate prompt list to probe how
visible the business at "${domain}" (in the geographic market "${geo}") is
inside large-language-model answers (ChatGPT, Claude, Gemini, Perplexity)
and Google's AI Overview.

Output ONLY a JSON object of the form:
{ "prompts": ["...", "..."] }

Rules:
- Produce exactly ${PROMPT_GENERATION_COUNT} natural-language buyer queries.
- Each query should be the kind of thing a real prospect in the target
  market would type into an LLM or into Google when shopping for this
  kind of business.
- Mix: 60% local intent (include the city or state in the query), 30%
  category/service-specific intent (no geography), 10% comparative
  ("X vs Y", "best ___ for ___").
- Plain lowercase, 3–10 words each, no question marks unless natural.
- No duplicates. No filler. Do not include the brand name itself in any
  prompt.
- Examples (for a CPA in Atlanta): "best cpa in atlanta", "atlanta tax
  preparation for doctors", "cpa for s-corp tax planning georgia".

Do not output any commentary outside the JSON object.`

  let text: string
  try {
    text = await callClaude(prompt, {
      model: SNAPSHOT_MODEL,
      maxTokens: 2048,
    })
  } catch (err) {
    if (err instanceof ClaudeApiError) {
      throw new Error(`Prompt generation failed: ${err.message}`)
    }
    throw err
  }

  const stripped = text
    .replace(/^```[a-z]*\n?/i, "")
    .replace(/```\s*$/i, "")
    .trim()
  const first = stripped.indexOf("{")
  const last = stripped.lastIndexOf("}")
  const jsonStr = first >= 0 && last > first ? stripped.slice(first, last + 1) : stripped
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonStr)
  } catch (err) {
    throw new Error(
      `Prompt generation returned non-JSON: ${err instanceof Error ? err.message : "unknown"}`,
    )
  }
  const schema = z.object({ prompts: z.array(z.string().min(1)) })
  const result = schema.safeParse(parsed)
  if (!result.success) {
    throw new Error(`Prompt generation shape invalid: ${result.error.message}`)
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of result.data.prompts) {
    const norm = raw.trim().toLowerCase()
    if (!norm || seen.has(norm)) continue
    seen.add(norm)
    out.push(norm)
  }
  return out
}

// ────────────────────────────────────────────────────────────────────────────
// Pipeline.

export async function POST(request: Request) {
  return runTool<typeof Input, SnapshotData>(
    request,
    Input,
    async (input, { dfs }) => {
      const warnings: string[] = []
      const startedAt = Date.now()
      const domain = stripDomain(input.domain)

      // ── Geo resolution ────────────────────────────────────────────────
      // The client side LocationAutocomplete forwards a DFS-validated
      // `location_code`. We re-fetch the full row so we have the parent
      // chain (needed for `resolveCountryFor`). Two location buckets:
      //   • `geoParams` — the city/state code the user picked. Used by
      //     SERP, which benefits from city-level granularity.
      //   • `countryParams` — the country that contains it (US default).
      //     Used by `keywords_search_volume`, which only meaningfully
      //     accepts country-level codes.
      // The `llm_mentions/*` endpoints don't accept location params at all
      // (40501 "Invalid Field: 'location_name'" / 'location_code') — they
      // run global.
      const geoLoc = await lookupLocationByCode(input.locationCode).catch(
        () => null,
      )
      if (!geoLoc) {
        throw new Error(
          `DataForSEO location_code ${input.locationCode} could not be looked up. Re-pick the geo from the dropdown.`,
        )
      }
      const resolvedGeo = geoLoc.location_name
      const countryLoc = await resolveCountryFor(geoLoc).catch(() => null)
      const geoParams = locationParams(geoLoc)!
      const countryParams = locationParams(countryLoc ?? geoLoc)!

      // ── Stage 1: candidate prompts + AI search volume ─────────────────
      const candidates = await generateCandidatePrompts(domain, resolvedGeo)
      if (candidates.length === 0) {
        throw new Error("Prompt generation returned zero candidates.")
      }

      const volumeEnv = await dfs(
        "/v3/ai_optimization/ai_keyword_data/keywords_search_volume/live",
        [
          {
            keywords: candidates,
            ...countryParams,
          },
        ],
      )

      type VolumeItem = {
        keyword?: string
        ai_search_volume?: number | null
        search_volume?: number | null
      }
      // The AI Keyword Data endpoint returns items nested under
      // `result[*].items[*]`. dfsItems handles that shape.
      const volumeRowsRaw = dfsItems<VolumeItem>(volumeEnv)
      const volumeMap = new Map<string, number>()
      for (const row of volumeRowsRaw) {
        if (!row.keyword) continue
        const v = row.ai_search_volume ?? row.search_volume ?? 0
        volumeMap.set(row.keyword.toLowerCase(), v)
      }
      // Some DFS endpoints place result rows directly at result[*]; pick those up too.
      const volumeRowsFlat = dfsResultItems<VolumeItem>(volumeEnv)
      for (const row of volumeRowsFlat) {
        if (!row.keyword) continue
        if (!volumeMap.has(row.keyword.toLowerCase())) {
          volumeMap.set(
            row.keyword.toLowerCase(),
            row.ai_search_volume ?? row.search_volume ?? 0,
          )
        }
      }

      const scored = candidates
        .map((p) => ({ prompt: p, volume: volumeMap.get(p) ?? 0 }))
        .sort((a, b) => b.volume - a.volume)

      // Prefer prompts with measurable volume but fall back to top-N if all
      // are zero (the AI Keyword Data endpoint occasionally returns 0 across
      // the board for niche verticals; we'd rather show *something* than
      // collapse the whole snapshot).
      let prompts = scored.filter((s) => s.volume > 0).slice(0, KEPT_PROMPTS)
      if (prompts.length === 0) {
        warnings.push(
          "AI search volume came back zero for every candidate prompt; falling back to the first 25 generated.",
        )
        prompts = scored.slice(0, KEPT_PROMPTS)
      }
      const promptList = prompts.map((p) => p.prompt)

      // ── Stage 2/3/4 in parallel ───────────────────────────────────────

      // Representative prompts used for top_domains / top_pages aggregation:
      // pick the 5 highest-volume keywords so the cited-domain ranking is
      // anchored to the most-asked queries (vs. flattening across 25 calls).
      const repPrompts = promptList.slice(0, SUGGESTION_KEYWORDS_FOR_RANKING)
      const samplePrompts = promptList.slice(0, SAMPLE_RESPONSES)

      // LLM Mentions endpoints reject any location field (40501) — pass only
      // the target. They run against DFS's global cached LLM-response index.
      //
      // Body shape (per dfseo-tools-runner.ts):
      //   { target: [{ keyword } | { domain }], ... }
      // `target` is an ARRAY of OBJECTS, where each object carries either
      // `{ keyword: "..." }` or `{ domain: "..." }`. Passing a flat `keyword`
      // top-level field (the old shape) now yields 40501.
      const llmAggBody = [{ target: [{ domain }] }]

      const [
        llmAggEnv,
        topDomainsEnvs,
        topPagesEnvs,
        mentionsSearchEnvs,
        serpEnvs,
        sampleResponseEnvs,
      ] = await Promise.all([
        dfs(
          "/v3/ai_optimization/llm_mentions/aggregated_metrics/live",
          llmAggBody,
        ).catch((err: unknown) => {
          warnings.push(`aggregated_metrics failed: ${describe(err)}`)
          return null
        }),
        Promise.all(
          repPrompts.map((kw) =>
            dfs("/v3/ai_optimization/llm_mentions/top_domains/live", [
              { target: [{ keyword: kw }], limit: 20 },
            ]).catch(captureWarning(warnings, "top_domains", kw)),
          ),
        ),
        Promise.all(
          repPrompts.map((kw) =>
            dfs("/v3/ai_optimization/llm_mentions/top_pages/live", [
              { target: [{ keyword: kw }], limit: 20 },
            ]).catch(captureWarning(warnings, "top_pages", kw)),
          ),
        ),
        Promise.all(
          promptList.map((kw) =>
            dfs("/v3/ai_optimization/llm_mentions/search/live", [
              {
                target: [{ keyword: kw }],
                limit: 50,
                order_by: ["ai_search_volume,desc"],
              },
            ]).catch(captureWarning(warnings, "llm_mentions_search", kw)),
          ),
        ),
        Promise.all(
          promptList.map((kw) =>
            dfs("/v3/serp/google/organic/live/advanced", [
              {
                keyword: kw,
                ...geoParams,
                depth: 10,
              },
            ]).catch(captureWarning(warnings, "serp_advanced", kw)),
          ),
        ),
        Promise.all(
          samplePrompts.map((kw) =>
            dfs(
              "/v3/ai_optimization/chat_gpt/llm_responses/live",
              // `model_name` is required (40501 'Invalid Field' if omitted).
              // gpt-4.1-mini matches the default the existing single-tool
              // runner uses.
              [{ user_prompt: kw, model_name: "gpt-4.1-mini" }],
              { timeoutMs: 240_000 },
            ).catch(captureWarning(warnings, "chat_gpt_response", kw)),
          ),
        ),
      ])

      // ── Parse llm_mentions/search results (per-prompt × per-platform). ─
      type MentionItem = {
        llm_provider?: string | null
        llm_model?: string | null
        platform?: string | null
        brand_position?: number | null
        brand_mentions?: number | null
        domain?: string | null
        url?: string | null
        sources?: { url?: string; domain?: string }[] | null
        citations?: { url?: string; domain?: string }[] | null
      }
      // promptCoverage[i].platformsMentioned = { chat_gpt: true|false, … }
      const platformsByPrompt: boolean[][] = promptList.map(() =>
        KNOWN_LLM_KEYS.map(() => false),
      )
      let totalMentions = 0
      const promptsWithAnyMention = new Set<number>()

      mentionsSearchEnvs.forEach((env, promptIdx) => {
        if (!env) return
        for (const item of dfsItems<MentionItem>(env)) {
          const llmKey = normalizeLlmKey(item.llm_model ?? item.llm_provider ?? item.platform)
          if (!llmKey) continue
          const colIdx = KNOWN_LLM_KEYS.indexOf(llmKey as (typeof KNOWN_LLM_KEYS)[number])
          if (colIdx < 0) continue
          // Match against the target domain: check `domain`, `url`, citations,
          // and source URLs. DFS returns slightly different shapes between
          // platforms; staying lenient is safer than picking one path.
          const matches = mentionMatchesDomain(item, domain)
          if (matches) {
            platformsByPrompt[promptIdx][colIdx] = true
            totalMentions += item.brand_mentions ?? 1
            promptsWithAnyMention.add(promptIdx)
          }
        }
      })

      // ── Parse SERP AI overview per prompt ─────────────────────────────
      const aiOverviewState: ("cited" | "triggered" | "not-triggered")[] = promptList.map(
        () => "not-triggered",
      )
      const aiOverviewCards: AiOverviewCard[] = []
      let overviewsTriggered = 0

      serpEnvs.forEach((env, promptIdx) => {
        if (!env) return
        const overview = extractAiOverview(env)
        if (!overview) return
        overviewsTriggered++
        const cited = overview.citations.some((c) =>
          c.toLowerCase().includes(domain),
        )
        aiOverviewState[promptIdx] = cited ? "cited" : "triggered"
        if (aiOverviewCards.length < 9) {
          aiOverviewCards.push({
            prompt: promptList[promptIdx],
            brandCited: cited,
            overviewText: overview.text,
            citations: overview.citations.slice(0, 6),
          })
        }
      })

      // ── Sample ChatGPT responses ──────────────────────────────────────
      const sampleResponses: SampleResponse[] = []
      sampleResponseEnvs.forEach((env, i) => {
        if (!env) return
        const parsed = extractChatGptResponse(env)
        if (!parsed) return
        const cited = parsed.citations.some((c) =>
          c.toLowerCase().includes(domain),
        )
        sampleResponses.push({
          prompt: samplePrompts[i],
          responseText: parsed.text,
          citations: parsed.citations,
          brandCited: cited,
        })
      })

      // ── Top domains / top pages aggregation across representative prompts.
      type CitedDomainItem = {
        domain?: string
        mentions_count?: number | null
        citation_count?: number | null
        mentions?: number | null
      }
      type CitedPageItem = {
        url?: string
        mentions_count?: number | null
        citation_count?: number | null
        mentions?: number | null
      }

      const domainCounts = new Map<string, number>()
      for (const env of topDomainsEnvs) {
        if (!env) continue
        for (const item of dfsItems<CitedDomainItem>(env)) {
          if (!item.domain) continue
          const cnt =
            item.mentions_count ?? item.citation_count ?? item.mentions ?? 0
          domainCounts.set(
            item.domain.toLowerCase(),
            (domainCounts.get(item.domain.toLowerCase()) ?? 0) + cnt,
          )
        }
      }
      const pageCounts = new Map<string, number>()
      for (const env of topPagesEnvs) {
        if (!env) continue
        for (const item of dfsItems<CitedPageItem>(env)) {
          if (!item.url) continue
          const cnt =
            item.mentions_count ?? item.citation_count ?? item.mentions ?? 0
          pageCounts.set(item.url, (pageCounts.get(item.url) ?? 0) + cnt)
        }
      }

      const sortedDomains = [...domainCounts.entries()].sort(
        (a, b) => b[1] - a[1],
      )
      const sortedPages = [...pageCounts.entries()].sort((a, b) => b[1] - a[1])

      const topDomains: SourceRow[] = sortedDomains
        .slice(0, 10)
        .map(([value, count], i) => ({ rank: i + 1, value, count }))
      const topPages: SourceRow[] = sortedPages
        .slice(0, 10)
        .map(([value, count], i) => ({ rank: i + 1, value, count }))

      // ── Competitor auto-detect: top non-target domains in top_domains ──
      const competitorDomains: string[] = []
      for (const [d] of sortedDomains) {
        if (competitorDomains.length >= COMPETITOR_COUNT) break
        if (sameDomain(d, domain)) continue
        // Exclude obvious aggregator / directory domains so the competitive
        // bar chart is anchored to real category competitors. The aggregator
        // domains still show up in the "Top cited sources" section.
        if (isAggregatorDomain(d)) continue
        competitorDomains.push(d)
      }

      // ── Cross-aggregated metrics across target + competitors ──────────
      let competitors: CompetitorBar[] = []
      if (competitorDomains.length > 0) {
        // cross_aggregated_metrics takes a `target` array — one object per
        // brand to compare. We pass the target domain + auto-detected
        // competitor domains so DFS returns one row of metrics per domain.
        const crossEnv = await dfs(
          "/v3/ai_optimization/llm_mentions/cross_aggregated_metrics/live",
          [
            {
              target: [domain, ...competitorDomains].map((d) => ({ domain: d })),
            },
          ],
        ).catch((err: unknown) => {
          warnings.push(`cross_aggregated_metrics failed: ${describe(err)}`)
          return null
        })

        if (crossEnv) {
          type CrossItem = {
            keyword?: string
            target?: { domain?: string; keyword?: string } | string
            domain?: string
            mentions_count?: number | null
            mentions?: number | null
          }
          const rows = dfsItems<CrossItem>(crossEnv)
          for (const it of rows) {
            const fromTarget =
              typeof it.target === "object" && it.target
                ? (it.target.domain ?? it.target.keyword ?? "")
                : typeof it.target === "string"
                  ? it.target
                  : ""
            const dom = (fromTarget || it.keyword || it.domain || "").toLowerCase()
            if (!dom) continue
            const count = it.mentions_count ?? it.mentions ?? 0
            competitors.push({
              domain: dom,
              mentions: count,
              isTarget: sameDomain(dom, domain),
            })
          }
        }
      }

      // Fallback: if cross_aggregated_metrics didn't return rows, synthesize
      // the chart from the aggregated top_domains data + target's
      // own measured mention count so the section still renders.
      if (competitors.length === 0) {
        const targetMentions = totalMentions
        competitors = [
          { domain, mentions: targetMentions, isTarget: true },
          ...competitorDomains.map((d) => ({
            domain: d,
            mentions: domainCounts.get(d) ?? 0,
            isTarget: false,
          })),
        ]
      }
      // Ensure the target row exists even if cross_aggregated returned only
      // competitor rows.
      if (!competitors.some((c) => c.isTarget)) {
        competitors.unshift({
          domain,
          mentions: totalMentions,
          isTarget: true,
        })
      }
      competitors.sort((a, b) => b.mentions - a.mentions)

      // ── Platform breakdown — derive from per-prompt mention matrix ────
      const platformBreakdown: PlatformBreakdown[] = KNOWN_LLM_KEYS.map(
        (key, colIdx) => {
          let promptsMentioned = 0
          for (const row of platformsByPrompt) {
            if (row[colIdx]) promptsMentioned++
          }
          const promptsTotal = promptList.length
          return {
            platform: llmDisplayName(key),
            mentionPct: promptsTotal
              ? (promptsMentioned / promptsTotal) * 100
              : null,
            promptsMentioned,
            promptsTotal,
          }
        },
      )

      // ── Aggregated-metrics override (if DFS returned a clean count) ───
      // The per-prompt llm_mentions/search pass is our source of truth for
      // mention rate (it's directly computed from the 25-prompt sample). We
      // fold the aggregated_metrics endpoint output into the warnings list
      // when it disagrees significantly, but don't replace the headline.
      const aiMentionRatePct = promptList.length
        ? (promptsWithAnyMention.size / promptList.length) * 100
        : null
      const aiOverviewRatePct = promptList.length
        ? (overviewsTriggered / promptList.length) * 100
        : null

      // ── Competitive rank (target's position in `competitors` sorted) ──
      const competitiveRank: TopLine["competitiveRank"] = competitors.length
        ? {
            position:
              competitors.findIndex((c) => c.isTarget) + 1 || competitors.length,
            outOf: competitors.length,
          }
        : null

      // ── Prompt coverage rows ─────────────────────────────────────────
      const promptCoverage: PromptCoverageRow[] = promptList.map((p, idx) => {
        const platformsMentioned: Record<string, boolean> = {}
        KNOWN_LLM_KEYS.forEach((k, colIdx) => {
          platformsMentioned[llmDisplayName(k)] = platformsByPrompt[idx][colIdx]
        })
        return {
          prompt: p,
          aiSearchVolume: volumeMap.get(p) ?? null,
          platformsMentioned,
          aiOverview: aiOverviewState[idx],
        }
      })

      // ── Top-line container ───────────────────────────────────────────
      const topLine: TopLine = {
        aiMentionRatePct,
        totalMentions,
        aiOverviewRatePct,
        competitiveRank,
      }

      // ── Validation: surface aggregated_metrics if present (informational).
      if (llmAggEnv) {
        const agg = dfsItems<{ mentions_count?: number | null }>(llmAggEnv)
        const dfsTotal = agg.reduce((s, it) => s + (it.mentions_count ?? 0), 0)
        if (dfsTotal > 0 && totalMentions === 0) {
          // The per-prompt pass found nothing but the aggregated stream did —
          // probably means our domain-match heuristic missed a citation.
          warnings.push(
            `aggregated_metrics reports ${dfsTotal} historical mentions for ${domain} that the per-prompt search didn't surface.`,
          )
        }
      }

      console.log(
        `[ai-snapshot] domain=${domain} geo="${resolvedGeo}" prompts=${promptList.length} llmCalls=${mentionsSearchEnvs.length + serpEnvs.length + sampleResponseEnvs.length} duration=${Math.round((Date.now() - startedAt) / 100) / 10}s`,
      )

      return {
        data: {
          prospect: {
            domain,
            geo: input.locationName,
            resolvedGeo,
            promptCount: promptList.length,
            llmCount: KNOWN_LLM_KEYS.length,
            runAt: new Date().toISOString(),
          },
          topLine,
          competitors,
          platformBreakdown,
          sampleResponses,
          promptCoverage,
          topDomains,
          topPages,
          aiOverviewCards,
          warnings,
        },
        endpoints: [
          "/v3/ai_optimization/ai_keyword_data/keywords_search_volume/live",
          "/v3/ai_optimization/llm_mentions/aggregated_metrics/live",
          "/v3/ai_optimization/llm_mentions/cross_aggregated_metrics/live",
          "/v3/ai_optimization/llm_mentions/top_domains/live",
          "/v3/ai_optimization/llm_mentions/top_pages/live",
          "/v3/ai_optimization/llm_mentions/search/live",
          "/v3/ai_optimization/chat_gpt/llm_responses/live",
          "/v3/serp/google/organic/live/advanced",
        ],
        costUsd: dfsCost(
          volumeEnv,
          llmAggEnv,
          ...topDomainsEnvs,
          ...topPagesEnvs,
          ...mentionsSearchEnvs,
          ...serpEnvs,
          ...sampleResponseEnvs,
        ),
      }
    },
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Detail helpers.

function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * Returns a `.catch` handler that records the first failure per (endpoint,
 * keyword) into `warnings` and resolves to `null` so the downstream parser
 * skips that envelope. Dedupes so 25 parallel failures with the same root
 * cause don't blow up the warnings list.
 */
function captureWarning(
  warnings: string[],
  endpoint: string,
  context: string,
): (err: unknown) => null {
  return (err: unknown) => {
    const msg = describe(err)
    const line = `${endpoint}("${context.slice(0, 40)}"): ${msg}`
    if (!warnings.some((w) => w.startsWith(`${endpoint}(`))) {
      warnings.push(line)
    }
    return null
  }
}

function sameDomain(a: string, b: string): boolean {
  const na = stripDomain(a)
  const nb = stripDomain(b)
  if (na === nb) return true
  if (na.endsWith(`.${nb}`) || nb.endsWith(`.${na}`)) return true
  return false
}

const AGGREGATOR_DOMAINS = new Set([
  "reddit.com",
  "quora.com",
  "yelp.com",
  "wikipedia.org",
  "linkedin.com",
  "youtube.com",
  "facebook.com",
  "twitter.com",
  "x.com",
  "instagram.com",
  "pinterest.com",
  "thumbtack.com",
  "angi.com",
  "angieslist.com",
  "bbb.org",
  "google.com",
  "maps.google.com",
  "forbes.com",
  "investopedia.com",
  "nerdwallet.com",
])
function isAggregatorDomain(d: string): boolean {
  const norm = stripDomain(d)
  if (AGGREGATOR_DOMAINS.has(norm)) return true
  for (const agg of AGGREGATOR_DOMAINS) {
    if (norm.endsWith(`.${agg}`)) return true
  }
  return false
}

function mentionMatchesDomain(
  item: {
    domain?: string | null
    url?: string | null
    sources?: { url?: string; domain?: string }[] | null
    citations?: { url?: string; domain?: string }[] | null
    brand_domain?: string | null
    brand?: string | null
  },
  domain: string,
): boolean {
  const probe = (s: string | undefined | null): boolean =>
    !!s && s.toLowerCase().includes(domain)
  if (probe(item.domain)) return true
  if (probe(item.url)) return true
  if (probe(item.brand_domain)) return true
  if (probe(item.brand)) return true
  const sources = item.sources ?? item.citations ?? []
  for (const src of sources) {
    if (probe(src.url) || probe(src.domain)) return true
  }
  return false
}

function extractAiOverview(env: unknown): { text: string; citations: string[] } | null {
  const tasks = (env as { tasks?: { result?: { items?: unknown[] }[] }[] }).tasks ?? []
  for (const task of tasks) {
    for (const r of task.result ?? []) {
      const items = (r?.items ?? []) as { type?: string }[]
      for (const item of items) {
        if (item.type === "ai_overview") {
          return parseAiOverviewItem(item)
        }
      }
    }
  }
  return null
}

function parseAiOverviewItem(item: unknown): { text: string; citations: string[] } {
  const it = item as {
    text?: string | null
    markdown?: string | null
    description?: string | null
    items?: unknown[]
    references?: unknown[]
  }
  // The DFS "ai_overview" container places the actual narrative in nested
  // sub-items (often type="ai_overview_element" / "ai_overview_text"). Walk
  // both top-level fields and the nested items, concatenating any text we
  // find. References usually live under `references[*].url`.
  const textParts: string[] = []
  if (typeof it.text === "string") textParts.push(it.text)
  if (typeof it.markdown === "string") textParts.push(it.markdown)
  if (typeof it.description === "string") textParts.push(it.description)
  for (const sub of (it.items ?? []) as Record<string, unknown>[]) {
    if (typeof sub.text === "string") textParts.push(sub.text)
    if (typeof sub.markdown === "string") textParts.push(sub.markdown)
    if (typeof sub.description === "string") textParts.push(sub.description)
  }
  const text = textParts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim()
  const refs = (it.references ?? []) as { url?: string; domain?: string; source?: string }[]
  const citations: string[] = []
  for (const ref of refs) {
    if (ref.url) citations.push(ref.url)
    else if (ref.domain) citations.push(ref.domain)
    else if (ref.source) citations.push(ref.source)
  }
  return { text, citations }
}

function extractChatGptResponse(env: unknown): { text: string; citations: string[] } | null {
  const tasks = (env as { tasks?: { result?: unknown[] }[] }).tasks ?? []
  for (const task of tasks) {
    for (const r of task.result ?? []) {
      const items = (r as { items?: unknown[] }).items ?? []
      for (const item of items) {
        const it = item as {
          llm_response_text?: string | null
          text?: string | null
          response_text?: string | null
          citations?: { url?: string; domain?: string; source?: string }[] | null
          sources?: { url?: string; domain?: string; source?: string }[] | null
        }
        const text = it.llm_response_text ?? it.text ?? it.response_text ?? ""
        if (!text) continue
        const refs = it.citations ?? it.sources ?? []
        const citations: string[] = []
        for (const ref of refs) {
          if (ref.url) citations.push(ref.url)
          else if (ref.domain) citations.push(ref.domain)
          else if (ref.source) citations.push(ref.source)
        }
        return { text, citations }
      }
    }
  }
  return null
}
