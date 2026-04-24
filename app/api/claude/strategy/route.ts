import { NextResponse } from "next/server"
import { z } from "zod"
import {
  callClaudeDetailed,
  ClaudeApiError,
  OPUS_INPUT_PRICE_PER_MTOK,
  OPUS_OUTPUT_PRICE_PER_MTOK,
} from "@/lib/claude"

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

const intentEnum = z.enum([
  "informational",
  "commercial",
  "transactional",
  "navigational",
])
const recommendationEnum = z.enum(["target", "monitor", "skip"])

// We're more lenient than ScoredKeyword here because the user pastes from a
// CSV export that drops extra fields. Cluster + keyword are the only
// fields the strategy prompt really needs; the rest are nice-to-have context.
const keywordSchema = z
  .object({
    keyword: z.string().min(1),
    cluster: z.string().default("Uncategorized"),
    fitScore: z.number().optional(),
    intent: intentEnum.optional(),
    recommendation: recommendationEnum.optional(),
    search_volume: z.number().optional(),
    keyword_difficulty: z.number().optional(),
    cpc: z.number().optional(),
    competition_level: z.enum(["HIGH", "MEDIUM", "LOW"]).optional(),
  })
  .passthrough()

const bodySchema = z.object({
  partner: partnerSchema,
  keywords: z.array(keywordSchema).min(1, "At least one keyword is required"),
})

type ParsedBody = z.infer<typeof bodySchema>
type Keyword = z.infer<typeof keywordSchema>

const SYSTEM_PROMPT =
  "You are a senior SEO strategist for a local service business. You produce specific, actionable 6-month SEO strategies grounded in real keyword data — never generic 'do content marketing and build links' advice. Every recommendation must reference specific keywords, clusters, or pages from the input. Output only markdown — no preamble, no trailing commentary."

function formatNumber(n: number | undefined): string {
  if (n == null) return "—"
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 })
}

function groupByCluster(keywords: Keyword[]): Map<string, Keyword[]> {
  const map = new Map<string, Keyword[]>()
  for (const kw of keywords) {
    const name = kw.cluster || "Uncategorized"
    const list = map.get(name) ?? []
    list.push(kw)
    map.set(name, list)
  }
  for (const [name, list] of map) {
    list.sort((a, b) => (b.fitScore ?? 0) - (a.fitScore ?? 0))
    map.set(name, list)
  }
  return map
}

function buildPrompt(body: ParsedBody): string {
  const { partner, keywords } = body
  const clusters = groupByCluster(keywords)

  const lines: string[] = []
  lines.push(`# Partner profile`)
  lines.push(`Name: ${partner.name}`)
  lines.push(`Website: ${partner.website}`)
  lines.push(`Services:\n${partner.services}`)
  lines.push(`Service areas:\n${partner.serviceAreas}`)
  if (partner.partnerGoals)
    lines.push(`Partner goals:\n${partner.partnerGoals}`)
  if (partner.targetAudience)
    lines.push(`Target audience:\n${partner.targetAudience}`)
  if (partner.industryKnowledge)
    lines.push(`Industry knowledge:\n${partner.industryKnowledge}`)
  if (partner.contentMarketing)
    lines.push(`Content marketing context:\n${partner.contentMarketing}`)

  lines.push("")
  lines.push(
    `# Approved keyword clusters (${keywords.length} keywords across ${clusters.size} clusters)`,
  )
  for (const [name, list] of clusters) {
    const targetCount = list.filter((k) => k.recommendation === "target").length
    lines.push("")
    lines.push(
      `## Cluster: ${name} (${list.length} keywords${targetCount > 0 ? `, ${targetCount} target` : ""})`,
    )
    lines.push(
      `| Keyword | Volume | Difficulty | Intent | Fit | Rec |`,
    )
    lines.push(`|---|---:|---:|---|---:|---|`)
    for (const kw of list) {
      lines.push(
        `| ${kw.keyword} | ${formatNumber(kw.search_volume)} | ${formatNumber(kw.keyword_difficulty)} | ${kw.intent ?? "—"} | ${kw.fitScore ?? "—"} | ${kw.recommendation ?? "—"} |`,
      )
    }
  }

  lines.push("")
  lines.push(`# Task`)
  lines.push(
    `Write a 6-month SEO strategy document for this partner, grounded in the approved keyword clusters above. The document will be read by an SEO engineer who will execute against it, so be concrete: reference specific keywords, specific clusters, and (where relevant) specific URLs/slugs. Do NOT produce generic recommendations — anything like "create more content" or "build backlinks" without a target keyword or page attached to it is forbidden.`,
  )

  lines.push("")
  lines.push(`# Required sections (exactly these H2 headings, in this order)`)

  lines.push("")
  lines.push(`## Executive summary`)
  lines.push(
    `2-3 sentences. Name the 2-3 highest-leverage keyword clusters and the single biggest opportunity the data points to (e.g., "the Pricing & Estimates cluster has three transactional keywords above 500/month volume but no dedicated landing page yet").`,
  )

  lines.push("")
  lines.push(`## Page roadmap`)
  lines.push(
    `Break the pages into three H3 subsections: "New pages to create", "Existing pages to optimize", and "Existing pages to consolidate/redirect". For each page entry, include:`,
  )
  lines.push(
    `- **Proposed URL slug** (your best guess — e.g. \`/emergency-plumbing-atlanta/\`). For existing pages, infer the likely URL from the partner's site structure; flag it as an assumption if unsure.`,
  )
  lines.push(
    `- **Target keyword cluster** (must match one of the cluster names above)`,
  )
  lines.push(
    `- **Primary + 2-3 secondary keywords** (must come verbatim from the approved list)`,
  )
  lines.push(`- **Intent** (informational / commercial / transactional)`)
  lines.push(
    `- **One-sentence rationale** that references actual data (volume, difficulty, existing cluster gaps, etc.)`,
  )
  lines.push("")
  lines.push(
    `Produce 4-10 page entries total across the three subsections. If a subsection has no entries, write "None identified — [specific reason based on the data]" rather than omitting it.`,
  )

  lines.push("")
  lines.push(`## FAQ bank per cluster`)
  lines.push(
    `For EACH cluster above, provide an H3 heading with the cluster name and 5-10 FAQ-style questions users in that cluster would actually ask. Phrase them as real questions ("How much does …?", "Can I …?", "When should I …?"). These will become FAQ schema / on-page FAQ sections. Draw from the keywords themselves — a cluster with "emergency drain service atlanta" should yield questions like "How fast can a plumber respond to an emergency in Atlanta?", not generic plumbing trivia.`,
  )

  lines.push("")
  lines.push(`## Internal linking plan`)
  lines.push(
    `Identify 2-3 **hub pages** (high-level topical landing pages that should pull equity) and, for each, list the **spoke pages** that should link up to it. For each hub→spoke relationship, specify recommended anchor text patterns (2-3 variations — exact-match, partial-match, natural phrase). Tie hub pages to clusters. Keep this section tight — aim for a compact table or nested bullet list, not prose.`,
  )

  lines.push("")
  lines.push(`## Priority ordering for the 6-month cycle`)
  lines.push(
    `Assign each page-roadmap entry to a specific month (Month 1 through Month 6). Lead with the highest-impact transactional clusters in months 1-2, support/informational content in the middle months, and consolidation/cleanup near the end. Use a month-by-month list ("### Month 1", "### Month 2", ...) and include a one-line justification for the month placement of each item.`,
  )

  lines.push("")
  lines.push(`# Style rules`)
  lines.push(
    `- Output valid markdown only. No preamble, no "Here is the strategy:", no closing commentary.`,
  )
  lines.push(
    `- Do NOT include sections other than the five above.`,
  )
  lines.push(
    `- Keep the whole document under 2000 words. Dense over fluffy.`,
  )
  lines.push(
    `- Every concrete recommendation must cite a specific keyword or cluster from the input. If you cannot tie a recommendation to input data, omit it.`,
  )

  return lines.join("\n")
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

  const prompt = buildPrompt(parsed.data)
  try {
    const { text, usage } = await callClaudeDetailed(prompt, {
      system: SYSTEM_PROMPT,
      maxTokens: 8192,
    })
    const estimatedCostUsd =
      (usage.input_tokens / 1_000_000) * OPUS_INPUT_PRICE_PER_MTOK +
      (usage.output_tokens / 1_000_000) * OPUS_OUTPUT_PRICE_PER_MTOK
    return NextResponse.json({
      strategy: text,
      usage: {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        estimatedCostUsd,
      },
    })
  } catch (error: unknown) {
    console.error("[api/claude/strategy] failed:", error)
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
