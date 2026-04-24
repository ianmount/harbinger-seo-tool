import { NextResponse } from "next/server"
import { z } from "zod"
import { callClaude, ClaudeApiError } from "@/lib/claude"
import type {
  KeywordCluster,
  KeywordResult,
  ScoredKeyword,
} from "@/lib/types"

export const dynamic = "force-dynamic"

const partnerSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    services: z.string(),
    serviceAreas: z.string(),
    website: z.string(),
    partnerGoals: z.string().optional(),
    targetAudience: z.string().optional(),
    contentMarketing: z.string().optional(),
    industryKnowledge: z.string().optional(),
  })
  .passthrough()

const rawKeywordSchema = z
  .object({
    keyword: z.string(),
    search_volume: z.number().optional(),
    cpc: z.number().optional(),
    competition: z.number().optional(),
    competition_level: z.enum(["HIGH", "MEDIUM", "LOW"]).optional(),
    keyword_difficulty: z.number().optional(),
  })
  .passthrough()

const gscRowSchema = z
  .object({
    query: z.string(),
    clicks: z.number(),
    impressions: z.number(),
    ctr: z.number(),
    position: z.number(),
  })
  .passthrough()

const gscQueryPageSchema = z
  .object({
    query: z.string(),
    page: z.string(),
    clicks: z.number(),
    impressions: z.number(),
    ctr: z.number(),
    position: z.number(),
  })
  .passthrough()

const ga4ConversionSchema = z.object({
  landingPage: z.string(),
  conversions: z.number(),
  conversionRate: z.number(),
})

const bodySchema = z.object({
  partner: partnerSchema,
  rawKeywords: z.array(rawKeywordSchema),
  gscHistorical: z.array(gscRowSchema).default([]),
  // Query→page mapping from GSC (same date range as gscHistorical). Used
  // alongside ga4Conversions to compute the per-keyword
  // pageConversionSignal. Optional — signal is off when either is absent.
  gscQueryPages: z.array(gscQueryPageSchema).optional(),
  // GA4 landing-page conversion data for the partner's property. Drives
  // the high-converting-page boost in the scoring prompt.
  ga4Conversions: z.array(ga4ConversionSchema).optional(),
  // Caller-controlled ceiling on how many keywords we feed to Claude (and,
  // since every scored keyword surfaces in the output, how many end up in
  // the results table). Hard-capped at MAX_KEYWORDS_HARD_LIMIT below to
  // stay inside Claude's output-token budget.
  maxKeywords: z.number().int().positive().optional(),
  // Display labels for the geographic locations the partner serves
  // (e.g. "Oklahoma City,Oklahoma,United States"). When provided, Claude
  // is instructed to drop keywords that reference an out-of-area
  // city/state so the results stay scoped to the partner's footprint.
  allowedLocations: z.array(z.string().trim().min(1)).optional(),
})

type ParsedBody = z.infer<typeof bodySchema>

// Claude's structured output. We use a compact tuple format
// `[keyword, cluster, fitScore, intent, recommendation]` to keep the
// per-keyword token cost as low as possible — a full object with field
// names runs ~80 tokens per keyword which hits max_tokens around 200
// keywords; the tuple runs ~15 tokens per keyword which comfortably
// handles 300+. Server-side we join the tuples back against the raw
// keyword list so we still keep all DFS metrics intact.
const intentEnum = z.enum([
  "informational",
  "commercial",
  "transactional",
  "navigational",
])
const recommendationEnum = z.enum(["target", "monitor", "skip"])

const claudeKeywordTupleSchema = z.tuple([
  z.string(), // keyword (verbatim input)
  z.string(), // cluster name
  z.number().min(0).max(100), // fitScore
  intentEnum, // intent
  recommendationEnum, // recommendation
])

const claudeResponseSchema = z.object({
  keywords: z.array(claudeKeywordTupleSchema),
})

type ClaudeKeywordTuple = z.infer<typeof claudeKeywordTupleSchema>

// Token budgets.
// - MAX_INPUT_KEYWORDS: hard cap on how many candidates we show Claude. At
//   ~30 prompt tokens per keyword (number, volume, difficulty, competition),
//   800 candidates is ~24k input tokens — comfortable in Opus 4.7's context.
// - DEFAULT_MAX_KEYWORDS: how many Claude selects and returns when the
//   caller doesn't specify.
// - MAX_OUTPUT_KEYWORDS: upper bound on the caller's request. Past this the
//   compact-tuple output risks truncating against CLAUDE_MAX_TOKENS (at ~15
//   output tokens per tuple, 500 tuples ≈ 7.5k output tokens).
const MAX_INPUT_KEYWORDS = 800
const DEFAULT_MAX_KEYWORDS = 300
const MAX_OUTPUT_KEYWORDS = 500
const CLAUDE_MAX_TOKENS = 32000

const SYSTEM_PROMPT =
  "You are an SEO strategist for a local service business. You see a pool of candidate keywords with their volume and difficulty; your job is to select the ones that will actually drive business value and group them into topical clusters. Be ruthless: off-topic, unrealistic-difficulty, and zero-volume keywords must be excluded from the output entirely — do not lower their fit score and keep them. Reply with a single JSON object — no markdown fences, no commentary."

function formatNumber(n: number | undefined): string {
  if (n == null) return "—"
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 })
}

/**
 * GSC pages come through as full URLs ("https://example.com/plumbing/");
 * GA4 landingPage comes through as path-only ("/plumbing/"). Normalize both
 * to a trailing-slashed path so they can be matched.
 */
function normalizePagePath(input: string): string {
  if (!input) return ""
  let path = input.trim()
  try {
    const u = new URL(path)
    path = u.pathname + (u.search || "")
  } catch {
    // Not a full URL; assume it's already path-only.
  }
  if (!path.startsWith("/")) path = `/${path}`
  return path
}

/**
 * For each GSC query, pick the single landing page that received the most
 * clicks (ties broken by impressions). This collapses the N:M query↔page
 * matrix into a stable one-page-per-query map for signal matching.
 */
function bestPageByQuery(
  rows: ReadonlyArray<{
    query: string
    page: string
    clicks: number
    impressions: number
  }>,
): Map<string, string> {
  type Best = { page: string; clicks: number; impressions: number }
  const best = new Map<string, Best>()
  for (const row of rows) {
    const key = row.query.trim().toLowerCase()
    if (!key || !row.page) continue
    const existing = best.get(key)
    if (
      !existing ||
      row.clicks > existing.clicks ||
      (row.clicks === existing.clicks && row.impressions > existing.impressions)
    ) {
      best.set(key, {
        page: normalizePagePath(row.page),
        clicks: row.clicks,
        impressions: row.impressions,
      })
    }
  }
  const result = new Map<string, string>()
  for (const [k, v] of best) result.set(k, v.page)
  return result
}

/**
 * A landing page counts as "high-converting" if it clears both a floor on
 * raw conversions (so we don't flag pages with a single conversion from a
 * single session) AND lands in the top tier of the partner's pages by
 * conversion count. Returns a Set of normalized paths.
 */
function highConvertingPages(
  conversions: ReadonlyArray<{ landingPage: string; conversions: number }>,
): Set<string> {
  const MIN_CONVERSIONS = 3
  const eligible = conversions.filter((c) => c.conversions >= MIN_CONVERSIONS)
  if (eligible.length === 0) return new Set()
  // Sort desc and keep the top third (at least one page). This catches the
  // obvious winners without over-rewarding pages that are barely above the
  // floor — a round-about top-quartile proxy that works for short lists.
  const sorted = eligible
    .slice()
    .sort((a, b) => b.conversions - a.conversions)
  const cutoff = Math.max(1, Math.ceil(sorted.length / 3))
  const pages = new Set<string>()
  for (const row of sorted.slice(0, cutoff)) {
    pages.add(normalizePagePath(row.landingPage))
  }
  return pages
}

function buildPrompt(
  body: ParsedBody,
  keywords: KeywordResult[],
  targetCount: number,
  highConvertingKeywords: ReadonlySet<string>,
  highConvertingPageList: ReadonlyArray<{
    landingPage: string
    conversions: number
    conversionRate: number
  }>,
): string {
  const { partner, gscHistorical } = body

  const topHistorical = gscHistorical
    .slice()
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 30)

  const lines: string[] = []
  lines.push(`# Partner profile`)
  lines.push(`Name: ${partner.name}`)
  lines.push(`Website: ${partner.website}`)
  lines.push(`Services:\n${partner.services}`)
  lines.push(`Service areas:\n${partner.serviceAreas}`)
  if (partner.partnerGoals) lines.push(`Goals:\n${partner.partnerGoals}`)
  if (partner.targetAudience)
    lines.push(`Target audience:\n${partner.targetAudience}`)
  if (partner.industryKnowledge)
    lines.push(`Industry knowledge:\n${partner.industryKnowledge}`)

  const allowed = body.allowedLocations ?? []
  if (allowed.length > 0) {
    lines.push("")
    lines.push(`# Allowed service area`)
    lines.push(
      `The partner ONLY serves these locations. This is the authoritative geographic scope for keyword selection:`,
    )
    for (const loc of allowed) lines.push(`- ${loc}`)
    lines.push("")
    lines.push(
      `When evaluating each candidate keyword, DROP keywords that reference a geographic location outside this list. For example, if the allowed list has only Oklahoma locations, "dumpster rental dallas" must be dropped because Dallas is in Texas. A keyword that references a city WITHIN an allowed state (e.g. "dumpster rental tulsa" when "Oklahoma" appears above) is allowed. Keep keywords that are location-agnostic (no city/state at all) or use "near me" / "local".`,
    )
  }

  lines.push("")
  lines.push(`# Recent GSC queries (last 90 days, top ${topHistorical.length} by impressions)`)
  if (topHistorical.length === 0) {
    lines.push(`(no GSC data available)`)
  } else {
    lines.push(`| Query | Clicks | Impressions | Avg Position |`)
    lines.push(`|---|---:|---:|---:|`)
    for (const q of topHistorical) {
      lines.push(
        `| ${q.query} | ${q.clicks} | ${q.impressions} | ${q.position.toFixed(1)} |`,
      )
    }
  }

  if (highConvertingPageList.length > 0) {
    lines.push("")
    lines.push(`# GA4 high-converting pages (last 90 days)`)
    lines.push(
      `The partner's GA4 property identifies these landing pages as high converters. Keywords whose best-ranking GSC page is one of these pages already drive business value on that page — give them a modest fit-score boost (roughly +5 to +10 points) when they otherwise pass the selection criteria.`,
    )
    lines.push(`| Landing page | Conversions | Conv. rate |`)
    lines.push(`|---|---:|---:|`)
    for (const p of highConvertingPageList) {
      lines.push(
        `| ${p.landingPage} | ${p.conversions} | ${(p.conversionRate * 100).toFixed(1)}% |`,
      )
    }
    if (highConvertingKeywords.size > 0) {
      lines.push("")
      lines.push(
        `Candidate keywords whose current GSC landing page is one of those high converters (the boost applies when you select them):`,
      )
      for (const kw of highConvertingKeywords) lines.push(`- ${kw}`)
    }
  }

  lines.push("")
  lines.push(
    `# Candidate keywords (${keywords.length} total — you select the best ${targetCount})`,
  )
  lines.push(`| # | Keyword | Volume | Difficulty | Competition |`)
  lines.push(`|---:|---|---:|---:|---:|`)
  keywords.forEach((kw, i) => {
    lines.push(
      `| ${i + 1} | ${kw.keyword} | ${formatNumber(kw.search_volume)} | ${formatNumber(kw.keyword_difficulty)} | ${kw.competition_level ?? "—"} |`,
    )
  })

  lines.push("")
  lines.push(`# Task`)
  lines.push(
    `Select **up to ${targetCount}** keywords from the candidate pool above — the ones most worth this partner's time and budget — and group them into topical clusters. Fewer than ${targetCount} is fine if the pool genuinely runs out of good candidates; do NOT pad with weak keywords to hit the number.`,
  )
  lines.push("")
  lines.push(`## Selection criteria (in priority order)`)
  lines.push(
    `1. **Relevance (topical + geographic)** — the keyword must clearly match the partner's services or an adjacent service a customer would expect, AND must not reference an out-of-area location (see "Allowed service area" section above if present). A dumpster-rental company in Oklahoma should not surface "dumpster rental dallas" or "recycling tips" — drop both, don't demote them with a low fit score.`,
  )
  lines.push(
    `2. **Realistic difficulty** — a local service business at a normal scale cannot realistically rank for national broad-head terms with very high keyword_difficulty. Weight long-tail / mid-difficulty queries more favorably.`,
  )
  lines.push(
    `3. **Meaningful volume** — zero-volume keywords rarely justify content. Prefer keywords with at least some measurable search_volume. That said, a highly-relevant long-tail term with modest volume beats a high-volume off-topic term.`,
  )
  lines.push(
    `4. **Intent** — transactional and commercial keywords typically drive conversions for a service business. Informational keywords can still qualify when they support the funnel (how-to, cost, comparison), but hold them to a higher relevance bar.`,
  )
  if (highConvertingPageList.length > 0) {
    lines.push(
      `5. **High-converting-page signal** — if a candidate keyword's current GSC landing page is listed in the "GA4 high-converting pages" section above, that page is already driving real conversions. Boost the fitScore by about +5 to +10 points (cap at 100) for those keywords, since they defend a working asset. Do not invent this signal for keywords that aren't in the list.`,
    )
  }
  lines.push("")
  lines.push(`## Output fields per selected keyword`)
  lines.push(
    `- **cluster**: a short (2–4 word), human-readable topic label (e.g. "Emergency Repair", "Commercial Services", "Pricing & Estimates"). Prefer 4–10 clusters total across your selection; use the same cluster name consistently for keywords in the same group.`,
  )
  lines.push(
    `- **fitScore (0-100)**: how strongly you'd recommend this keyword for this partner, combining all four criteria above. Since the output is pre-filtered to your top picks, expect most scores to land 50–90. Reserve 85+ for the clear winners.`,
  )
  lines.push(
    `- **intent**: one of "informational", "commercial", "transactional", "navigational".`,
  )
  lines.push(
    `- **recommendation**: "target" = actively pursue now, "monitor" = track but not priority, "skip" = (should be rare in this output since we already filtered; use only if on reflection a selected keyword turns out weak).`,
  )

  lines.push("")
  lines.push(`# Output format`)
  lines.push(
    `Output exactly one JSON object. No prose, no markdown fences. Each selected keyword is a 5-element array in this exact order: [keyword (verbatim from input), cluster name, fitScore 0-100, intent, recommendation]. Intent is one of "informational"/"commercial"/"transactional"/"navigational". Recommendation is one of "target"/"monitor"/"skip".`,
  )
  lines.push("```")
  lines.push(`{`)
  lines.push(`  "keywords": [`)
  lines.push(
    `    ["plumber near me", "Local Demand", 88, "transactional", "target"],`,
  )
  lines.push(
    `    ["how often to service water heater", "Info & Guides", 42, "informational", "monitor"]`,
  )
  lines.push(`  ]`)
  lines.push(`}`)
  lines.push("```")
  lines.push(
    `The "keyword" field of each tuple must match a candidate from the pool above verbatim. Do NOT invent keywords. Return at most ${targetCount} tuples. Sort them by descending fitScore (best picks first).`,
  )

  return lines.join("\n")
}

function stripCodeFences(text: string): string {
  const trimmed = text.trim()
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i)
  return fenceMatch ? fenceMatch[1].trim() : trimmed
}

function extractJsonObject(text: string): string {
  const stripped = stripCodeFences(text)
  const first = stripped.indexOf("{")
  const last = stripped.lastIndexOf("}")
  if (first === -1 || last === -1 || last <= first) return stripped
  return stripped.slice(first, last + 1)
}

/**
 * When Claude hits max_tokens mid-generation, the JSON array is cut off
 * partway through a tuple. Walk the text to find the last *complete* tuple
 * (i.e., the last `]` that closed an inner array while we were still inside
 * the outer `keywords` array) and close the wrapper with `]}`. Returns the
 * healed text, or the original if no healable prefix was found.
 */
function healTruncatedJson(text: string): string {
  let depth = 0
  let lastGoodTupleEnd = -1
  let inString = false
  let escape = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (escape) {
      escape = false
      continue
    }
    if (c === "\\") {
      escape = true
      continue
    }
    if (c === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (c === "[") depth++
    else if (c === "]") {
      depth--
      // depth 1 inside the object's outer `keywords` array means we just
      // closed an inner tuple. Remember that as a safe cut-off point.
      if (depth === 1) lastGoodTupleEnd = i
    }
  }
  if (lastGoodTupleEnd < 0) return text
  return `${text.slice(0, lastGoodTupleEnd + 1)}]}`
}

async function callClaudeForKeywords(
  prompt: string,
): Promise<z.infer<typeof claudeResponseSchema>> {
  const raw = await callClaude(prompt, {
    system: SYSTEM_PROMPT,
    maxTokens: CLAUDE_MAX_TOKENS,
  })
  const jsonText = extractJsonObject(raw)
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch (err) {
    // Claude may have hit max_tokens and left the array unclosed. Try
    // healing before giving up — losing some tail keywords is better
    // than failing the whole run.
    const healed = healTruncatedJson(jsonText)
    if (healed === jsonText) {
      throw new Error(
        `Claude did not return valid JSON: ${err instanceof Error ? err.message : "unknown"}`,
      )
    }
    try {
      parsed = JSON.parse(healed)
      console.warn(
        "[api/claude/keywords] healed truncated JSON; some tail keywords dropped",
      )
    } catch (healErr) {
      throw new Error(
        `Claude did not return valid JSON and could not be healed: ${healErr instanceof Error ? healErr.message : "unknown"}`,
      )
    }
  }
  const result = claudeResponseSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(
      `Claude response did not match schema: ${result.error.message}`,
    )
  }
  return result.data
}

function buildClusters(
  rawKeywords: KeywordResult[],
  scored: z.infer<typeof claudeResponseSchema>,
  keywordToPage: ReadonlyMap<string, string>,
  highConverterPages: ReadonlySet<string>,
  signalActive: boolean,
): KeywordCluster[] {
  const rawByKeyword = new Map<string, KeywordResult>()
  for (const kw of rawKeywords) {
    rawByKeyword.set(kw.keyword.toLowerCase(), kw)
  }

  const clusterMap = new Map<string, ScoredKeyword[]>()
  for (const entry of scored.keywords) {
    const [keyword, cluster, fitScore, intent, recommendation] =
      entry as ClaudeKeywordTuple
    const raw = rawByKeyword.get(keyword.toLowerCase())
    if (!raw) {
      // Claude occasionally paraphrases; drop unknowns rather than inventing metrics.
      continue
    }
    const landingPage = keywordToPage.get(keyword.toLowerCase())
    const merged: ScoredKeyword = {
      ...raw,
      cluster,
      fitScore: Math.round(fitScore),
      intent,
      recommendation,
      ...(signalActive
        ? {
            landingPage,
            pageConversionSignal: landingPage
              ? highConverterPages.has(landingPage)
              : false,
          }
        : {}),
    }
    const list = clusterMap.get(cluster) ?? []
    list.push(merged)
    clusterMap.set(cluster, list)
  }

  return Array.from(clusterMap.entries())
    .map(([name, keywords]) => ({
      name,
      keywords: keywords.sort((a, b) => b.fitScore - a.fitScore),
    }))
    .sort((a, b) => {
      const aTop = a.keywords[0]?.fitScore ?? 0
      const bTop = b.keywords[0]?.fitScore ?? 0
      return bTop - aTop
    })
}

export async function POST(request: Request) {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON" },
      { status: 400 },
    )
  }
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request body", issues: parsed.error.flatten() },
      { status: 400 },
    )
  }

  // Dedupe by keyword (case-insensitive) in case the client didn't.
  const seen = new Set<string>()
  const deduped: KeywordResult[] = []
  for (const kw of parsed.data.rawKeywords) {
    const key = kw.keyword.trim().toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    deduped.push(kw)
  }

  if (deduped.length === 0) {
    return NextResponse.json(
      { error: "rawKeywords is empty — nothing to cluster" },
      { status: 400 },
    )
  }

  // How many keywords to surface (Claude's output target).
  const requestedMax = parsed.data.maxKeywords ?? DEFAULT_MAX_KEYWORDS
  const targetCount = Math.min(requestedMax, MAX_OUTPUT_KEYWORDS)

  // Full candidate pool for Claude to choose from. We intentionally show
  // Claude *more* than targetCount so selection is by fit-to-partner rather
  // than upstream ordering. Only cap at MAX_INPUT_KEYWORDS to keep the
  // prompt from exceeding a reasonable input-token budget.
  const candidates = deduped.slice(0, MAX_INPUT_KEYWORDS)
  const candidatesDropped = deduped.length - candidates.length

  // GA4 / GSC signal prep. The signal only activates when BOTH the GSC
  // query→page mapping and the GA4 conversions-by-page data are present —
  // either alone can't identify "the keyword's page is converting".
  const gscQueryPages = parsed.data.gscQueryPages ?? []
  const ga4Conversions = parsed.data.ga4Conversions ?? []
  const signalActive = gscQueryPages.length > 0 && ga4Conversions.length > 0
  const keywordToPage = signalActive
    ? bestPageByQuery(gscQueryPages)
    : new Map<string, string>()
  const highConverterPages = signalActive
    ? highConvertingPages(ga4Conversions)
    : new Set<string>()

  // Surface the candidate keywords whose current GSC page is a high converter
  // so the prompt can name them explicitly. Claude applies the fit boost;
  // the server re-applies the flag onto the returned tuples below so the UI
  // column reflects reality (not Claude's self-report).
  const highConvertingKeywords = new Set<string>()
  if (signalActive) {
    for (const kw of candidates) {
      const page = keywordToPage.get(kw.keyword.toLowerCase())
      if (page && highConverterPages.has(page)) {
        highConvertingKeywords.add(kw.keyword)
      }
    }
  }
  const highConvertingPageList = signalActive
    ? ga4Conversions
        .filter((c) => highConverterPages.has(normalizePagePath(c.landingPage)))
        .sort((a, b) => b.conversions - a.conversions)
    : []

  const prompt = buildPrompt(
    parsed.data,
    candidates,
    targetCount,
    highConvertingKeywords,
    highConvertingPageList,
  )
  try {
    let scored: z.infer<typeof claudeResponseSchema>
    try {
      scored = await callClaudeForKeywords(prompt)
    } catch (firstErr) {
      console.warn(
        "[api/claude/keywords] first attempt failed, retrying once:",
        firstErr instanceof Error ? firstErr.message : firstErr,
      )
      const retryPrompt = `${prompt}\n\n# Retry note\nYour previous response was invalid: ${firstErr instanceof Error ? firstErr.message : "parse error"}. Output ONLY the JSON object described above — no markdown, no commentary.`
      scored = await callClaudeForKeywords(retryPrompt)
    }

    // Defensive clamp in case Claude exceeded the target count. buildClusters
    // joins against the candidates list, so any scored keyword that isn't in
    // the pool is already dropped there.
    if (scored.keywords.length > targetCount) {
      scored = { keywords: scored.keywords.slice(0, targetCount) }
    }

    const clusters = buildClusters(
      candidates,
      scored,
      keywordToPage,
      highConverterPages,
      signalActive,
    )
    return NextResponse.json({
      clusters,
      // `truncated` now means candidates we never showed Claude at all
      // (input pool was larger than MAX_INPUT_KEYWORDS); separately report
      // how many candidates Claude chose to skip as a relevance signal.
      truncated: candidatesDropped,
      candidatesShown: candidates.length,
      targetCount,
      selected: scored.keywords.length,
      conversionSignalActive: signalActive,
    })
  } catch (error: unknown) {
    console.error("[api/claude/keywords] failed:", error)
    if (error instanceof ClaudeApiError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status ?? 502 },
      )
    }
    const message = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
