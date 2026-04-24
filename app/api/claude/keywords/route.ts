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

const bodySchema = z.object({
  partner: partnerSchema,
  rawKeywords: z.array(rawKeywordSchema),
  gscHistorical: z.array(gscRowSchema).default([]),
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

// Token-budget guard. 300 keywords × ~15 compact-output tokens ≈ 4.5k
// output tokens, well inside CLAUDE_MAX_TOKENS. The prompt itself caps
// around 15k input tokens at this count. If we ever need to go beyond
// 300, split into multiple Claude calls and merge clusters.
const MAX_KEYWORDS_TO_SCORE = 300
const CLAUDE_MAX_TOKENS = 32000

const SYSTEM_PROMPT =
  "You are an SEO strategist grouping keywords into topical clusters for a local service business. Be decisive: every keyword gets a cluster, a fit score, an intent, and a recommendation. Reply with a single JSON object — no markdown fences, no commentary."

function formatNumber(n: number | undefined): string {
  if (n == null) return "—"
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 })
}

function buildPrompt(body: ParsedBody, keywords: KeywordResult[]): string {
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

  lines.push("")
  lines.push(`# Keywords to classify (${keywords.length})`)
  lines.push(`| # | Keyword | Volume | Difficulty | Competition |`)
  lines.push(`|---:|---|---:|---:|---:|`)
  keywords.forEach((kw, i) => {
    lines.push(
      `| ${i + 1} | ${kw.keyword} | ${formatNumber(kw.search_volume)} | ${formatNumber(kw.keyword_difficulty)} | ${kw.competition_level ?? "—"} |`,
    )
  })

  lines.push("")
  lines.push(`# Instructions`)
  lines.push(
    `Group every keyword above into topical clusters appropriate for a local service business like this partner.`,
  )
  lines.push(
    `Prefer 4–10 clusters total. Cluster names should be short (2–4 words), human-readable, and reflect the topic (e.g. "Emergency Repair", "Commercial Services", "Pricing & Estimates").`,
  )
  lines.push(
    `For each keyword, assign:`,
  )
  lines.push(
    `- cluster: name of one of the clusters you created (must be consistent across keywords in the same cluster)`,
  )
  lines.push(
    `- fitScore (0-100): how good a fit this keyword is for this partner, considering volume, difficulty, commercial intent, and alignment with the partner's services. Reserve 80+ for keywords that are clearly worth pursuing; 40-79 for worth monitoring; below 40 for poor fit.`,
  )
  lines.push(
    `- intent: one of "informational", "commercial", "transactional", "navigational"`,
  )
  lines.push(
    `- recommendation: "target" if this keyword should be actively pursued (good fit + realistic difficulty for a local business), "monitor" if it's worth tracking but not the immediate priority, "skip" if the partner shouldn't invest in it (off-topic, unrealistic difficulty, or no meaningful volume)`,
  )

  lines.push("")
  lines.push(`# Output format`)
  lines.push(
    `Output exactly one JSON object. No prose, no markdown fences. Each keyword is a 5-element array in this exact order: [keyword (verbatim from input), cluster name, fitScore 0-100, intent, recommendation]. Intent is one of "informational"/"commercial"/"transactional"/"navigational". Recommendation is one of "target"/"monitor"/"skip".`,
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
    `Every one of the ${keywords.length} input keywords must appear exactly once as the first element of a tuple. Keep strings on one line; do not insert line breaks inside a tuple.`,
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
    const merged: ScoredKeyword = {
      ...raw,
      cluster,
      fitScore: Math.round(fitScore),
      intent,
      recommendation,
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

  const keywords = deduped.slice(0, MAX_KEYWORDS_TO_SCORE)
  const truncated = deduped.length - keywords.length

  const prompt = buildPrompt(parsed.data, keywords)
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

    const clusters = buildClusters(keywords, scored)
    return NextResponse.json({ clusters, truncated })
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
