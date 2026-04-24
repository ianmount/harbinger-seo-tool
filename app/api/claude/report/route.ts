import { NextResponse } from "next/server"
import { z } from "zod"
import { callClaude, ClaudeApiError } from "@/lib/claude"

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

const topQuerySchema = z.object({
  query: z.string(),
  clicks: z.number(),
  impressions: z.number(),
  ctr: z.number(),
  position: z.number(),
})

const topPageSchema = z.object({
  page: z.string(),
  clicks: z.number(),
  impressions: z.number(),
  ctr: z.number(),
  position: z.number(),
})

const dailySchema = z.object({
  date: z.string(),
  clicks: z.number(),
  impressions: z.number(),
  ctr: z.number(),
  position: z.number(),
})

const bodySchema = z.object({
  partner: partnerSchema,
  gscData: z.object({
    topQueries: z.array(topQuerySchema),
    topPages: z.array(topPageSchema),
    dailyClicks: z.array(dailySchema),
  }),
  dateRange: z.object({
    start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
})

type ParsedBody = z.infer<typeof bodySchema>

const SYSTEM_PROMPT =
  "You are a senior SEO analyst writing a monthly performance report for a local service business. Be specific and reference actual numbers from the data. Avoid generic SEO platitudes. Keep the full report under 500 words. Output only markdown — no preamble, no trailing commentary."

function formatNumber(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 })
}

function formatCtr(ctr: number): string {
  return `${(ctr * 100).toFixed(2)}%`
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function buildPrompt(body: ParsedBody): string {
  const { partner, gscData, dateRange } = body
  const topQueries = gscData.topQueries
    .slice()
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 20)
  const topPages = gscData.topPages
    .slice()
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 20)
  const totalClicks = gscData.dailyClicks.reduce((s, d) => s + d.clicks, 0)
  const totalImpressions = gscData.dailyClicks.reduce(
    (s, d) => s + d.impressions,
    0,
  )

  const lines: string[] = []
  lines.push(`# Partner`)
  lines.push(`Name: ${partner.name}`)
  lines.push(`Website: ${partner.website}`)
  lines.push(`Services:\n${partner.services}`)
  lines.push(`Service areas:\n${partner.serviceAreas}`)
  if (partner.partnerGoals) lines.push(`Partner goals:\n${partner.partnerGoals}`)
  if (partner.targetAudience)
    lines.push(`Target audience:\n${partner.targetAudience}`)
  if (partner.industryKnowledge)
    lines.push(`Industry knowledge:\n${partner.industryKnowledge}`)

  lines.push("")
  lines.push(`# Date range`)
  lines.push(`${dateRange.start} to ${dateRange.end}`)
  lines.push(
    `Totals: ${formatNumber(totalClicks)} clicks, ${formatNumber(totalImpressions)} impressions across ${gscData.dailyClicks.length} days`,
  )

  lines.push("")
  lines.push(`# Top queries by clicks (up to 20)`)
  lines.push(`| Query | Clicks | Impressions | CTR | Avg Position |`)
  lines.push(`|---|---:|---:|---:|---:|`)
  for (const q of topQueries) {
    lines.push(
      `| ${truncate(q.query, 80)} | ${formatNumber(q.clicks)} | ${formatNumber(q.impressions)} | ${formatCtr(q.ctr)} | ${q.position.toFixed(1)} |`,
    )
  }

  lines.push("")
  lines.push(`# Top pages by clicks (up to 20)`)
  lines.push(`| Page | Clicks | Impressions | CTR | Avg Position |`)
  lines.push(`|---|---:|---:|---:|---:|`)
  for (const p of topPages) {
    lines.push(
      `| ${truncate(p.page, 100)} | ${formatNumber(p.clicks)} | ${formatNumber(p.impressions)} | ${formatCtr(p.ctr)} | ${p.position.toFixed(1)} |`,
    )
  }

  lines.push("")
  lines.push(`# Daily clicks`)
  for (const d of gscData.dailyClicks) {
    lines.push(`${d.date}: ${d.clicks} clicks, ${d.impressions} impressions`)
  }

  lines.push("")
  lines.push(`# Writing instructions`)
  lines.push(
    `Write a monthly performance report in markdown with exactly these sections:`,
  )
  lines.push(
    `1. An H1 title like "# Performance Report — ${partner.name}" with the date range beneath it.`,
  )
  lines.push(
    `2. "## Executive summary" — one paragraph summarizing performance over the range. Reference total clicks and impressions.`,
  )
  lines.push(
    `3. "## Top queries" — 3–5 bullets, each referencing a specific query and its numbers. Note anything interesting (e.g. high-impression/low-CTR or high-position opportunities).`,
  )
  lines.push(
    `4. "## Top pages" — 3–5 bullets interpreting which pages are driving traffic and any noteworthy patterns.`,
  )
  lines.push(
    `5. "## Recommended actions" — exactly 2–3 bullets, each a concrete next-month action tied to a specific pattern in the data above. Avoid generic advice.`,
  )
  lines.push(
    `Do not include a preamble, do not apologize for missing data, do not add extra sections. Stay under 500 words total.`,
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

  if (
    parsed.data.gscData.topQueries.length === 0 &&
    parsed.data.gscData.topPages.length === 0 &&
    parsed.data.gscData.dailyClicks.length === 0
  ) {
    return NextResponse.json(
      {
        error:
          "No GSC data provided. Verify that the partner's website matches an accessible GSC property for the selected date range.",
      },
      { status: 400 },
    )
  }

  const prompt = buildPrompt(parsed.data)
  try {
    const report = await callClaude(prompt, {
      system: SYSTEM_PROMPT,
      maxTokens: 2048,
    })
    return NextResponse.json({ report })
  } catch (error: unknown) {
    console.error("[api/claude/report] failed:", error)
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
