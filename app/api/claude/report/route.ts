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
    ga4PropertyId: z.string().optional(),
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

const ga4LandingPageSchema = z.object({
  landingPage: z.string(),
  sessions: z.number(),
  conversions: z.number(),
  conversionRate: z.number(),
})

const ga4TrafficSourceSchema = z.object({
  source: z.string(),
  medium: z.string(),
  sessions: z.number(),
  conversions: z.number(),
})

const ga4ReportSchema = z.object({
  propertyId: z.string(),
  dateRange: z.object({ startDate: z.string(), endDate: z.string() }),
  sessions: z.number(),
  users: z.number(),
  conversions: z.number(),
  conversionsConfigured: z.boolean(),
  topLandingPages: z.array(ga4LandingPageSchema),
  trafficSources: z.array(ga4TrafficSourceSchema),
  organicOnly: z.array(ga4LandingPageSchema),
})

const bodySchema = z.object({
  partner: partnerSchema,
  gscData: z.object({
    topQueries: z.array(topQuerySchema),
    topPages: z.array(topPageSchema),
    dailyClicks: z.array(dailySchema),
  }),
  ga4Data: ga4ReportSchema.optional(),
  ga4PriorData: ga4ReportSchema.optional(),
  dateRange: z.object({
    start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
})

type ParsedBody = z.infer<typeof bodySchema>

const SYSTEM_PROMPT =
  "You are a senior SEO analyst writing a monthly performance report for a local service business. Be specific and reference actual numbers from the data. Integrate GSC search-side data with GA4 behavioral/conversion data when both are present — never treat them as separate reports. Avoid generic SEO platitudes. Keep the full report under 650 words. Output only markdown — no preamble, no trailing commentary."

function formatNumber(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 })
}

function formatCtr(ctr: number): string {
  return `${(ctr * 100).toFixed(2)}%`
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function formatPercentDelta(current: number, prior: number): string {
  if (prior <= 0) return current > 0 ? "new" : "0"
  const delta = ((current - prior) / prior) * 100
  const sign = delta >= 0 ? "+" : ""
  return `${sign}${delta.toFixed(1)}%`
}

function buildPrompt(body: ParsedBody): string {
  const { partner, gscData, ga4Data, ga4PriorData, dateRange } = body
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
    `GSC totals: ${formatNumber(totalClicks)} clicks, ${formatNumber(totalImpressions)} impressions across ${gscData.dailyClicks.length} days`,
  )

  lines.push("")
  lines.push(`# Top GSC queries by clicks (up to 20)`)
  lines.push(`| Query | Clicks | Impressions | CTR | Avg Position |`)
  lines.push(`|---|---:|---:|---:|---:|`)
  for (const q of topQueries) {
    lines.push(
      `| ${truncate(q.query, 80)} | ${formatNumber(q.clicks)} | ${formatNumber(q.impressions)} | ${formatCtr(q.ctr)} | ${q.position.toFixed(1)} |`,
    )
  }

  lines.push("")
  lines.push(`# Top GSC pages by clicks (up to 20)`)
  lines.push(`| Page | Clicks | Impressions | CTR | Avg Position |`)
  lines.push(`|---|---:|---:|---:|---:|`)
  for (const p of topPages) {
    lines.push(
      `| ${truncate(p.page, 100)} | ${formatNumber(p.clicks)} | ${formatNumber(p.impressions)} | ${formatCtr(p.ctr)} | ${p.position.toFixed(1)} |`,
    )
  }

  lines.push("")
  lines.push(`# Daily GSC clicks`)
  for (const d of gscData.dailyClicks) {
    lines.push(`${d.date}: ${d.clicks} clicks, ${d.impressions} impressions`)
  }

  if (ga4Data) {
    lines.push("")
    lines.push(`# GA4 behavioral data (property ${ga4Data.propertyId})`)
    const totalsLine = `Totals: ${formatNumber(ga4Data.sessions)} sessions, ${formatNumber(ga4Data.users)} users, ${formatNumber(ga4Data.conversions)} conversions`
    if (ga4PriorData) {
      lines.push(
        `${totalsLine} (prior period ${ga4PriorData.dateRange.startDate} to ${ga4PriorData.dateRange.endDate}: ${formatNumber(ga4PriorData.sessions)} sessions [${formatPercentDelta(ga4Data.sessions, ga4PriorData.sessions)}], ${formatNumber(ga4PriorData.users)} users [${formatPercentDelta(ga4Data.users, ga4PriorData.users)}], ${formatNumber(ga4PriorData.conversions)} conversions [${formatPercentDelta(ga4Data.conversions, ga4PriorData.conversions)}])`,
      )
    } else {
      lines.push(totalsLine)
    }
    if (!ga4Data.conversionsConfigured) {
      lines.push(
        `Note: no conversion events fired in this range. Treat conversion figures as "not configured" rather than a performance signal.`,
      )
    }

    if (ga4Data.trafficSources.length > 0) {
      const organicSessions = ga4Data.trafficSources
        .filter((t) => /organic/i.test(t.medium))
        .reduce((s, t) => s + t.sessions, 0)
      const organicShare = ga4Data.sessions
        ? ((organicSessions / ga4Data.sessions) * 100).toFixed(1)
        : "0.0"
      lines.push("")
      lines.push(
        `## Traffic sources (top by sessions; ${organicShare}% of sessions came from organic medium)`,
      )
      lines.push(`| Source | Medium | Sessions | Conversions |`)
      lines.push(`|---|---|---:|---:|`)
      for (const t of ga4Data.trafficSources.slice(0, 15)) {
        lines.push(
          `| ${truncate(t.source || "(not set)", 40)} | ${truncate(t.medium || "(not set)", 30)} | ${formatNumber(t.sessions)} | ${formatNumber(t.conversions)} |`,
        )
      }
    }

    if (ga4Data.topLandingPages.length > 0) {
      lines.push("")
      lines.push(`## Top landing pages (all channels)`)
      lines.push(`| Landing page | Sessions | Conversions | Conv. rate |`)
      lines.push(`|---|---:|---:|---:|`)
      for (const p of ga4Data.topLandingPages) {
        lines.push(
          `| ${truncate(p.landingPage, 100)} | ${formatNumber(p.sessions)} | ${formatNumber(p.conversions)} | ${formatCtr(p.conversionRate)} |`,
        )
      }
    }

    if (ga4Data.organicOnly.length > 0) {
      lines.push("")
      lines.push(`## Top organic-search landing pages`)
      lines.push(`| Landing page | Sessions | Conversions | Conv. rate |`)
      lines.push(`|---|---:|---:|---:|`)
      for (const p of ga4Data.organicOnly) {
        lines.push(
          `| ${truncate(p.landingPage, 100)} | ${formatNumber(p.sessions)} | ${formatNumber(p.conversions)} | ${formatCtr(p.conversionRate)} |`,
        )
      }
    }
  } else {
    lines.push("")
    lines.push(`# GA4 behavioral data`)
    lines.push(
      `(Not available — the partner has no GA4 property configured in Airtable. Write a GSC-only report and do NOT speculate about sessions, users, or conversions.)`,
    )
  }

  lines.push("")
  lines.push(`# Writing instructions`)
  lines.push(
    `Write a monthly performance report in markdown with exactly these sections:`,
  )
  lines.push(
    `1. An H1 title like "# Performance Report — ${partner.name}" with the date range beneath it.`,
  )
  if (ga4Data) {
    lines.push(
      `2. "## Executive summary" — one paragraph. Reference GSC totals (clicks, impressions) AND GA4 totals (sessions, users, conversions). Call out the organic share of sessions and, if prior-period numbers are present, the trend vs. prior period.`,
    )
    lines.push(
      `3. "## Search performance" — 3–5 bullets grounded in the top GSC queries and pages. Note interesting patterns (high-impression/low-CTR, strong-position opportunities, gains vs. losses).`,
    )
    lines.push(
      `4. "## Traffic & conversions" — 3–5 bullets covering the GA4 data: which landing pages drive the most sessions, which convert best, how the traffic-source mix breaks down (emphasize organic vs. other channels), and any standout organic-search landing pages. If conversions are not configured, say so in one bullet and skip conversion-rate commentary.`,
    )
    lines.push(
      `5. "## Recommended actions" — exactly 2–3 bullets. Each must tie to a specific pattern above. At least one action must reference GA4 behavior (e.g. "page X gets organic traffic but converts below the site average — investigate CTA placement"). Avoid generic SEO advice.`,
    )
  } else {
    lines.push(
      `2. "## Executive summary" — one paragraph summarizing GSC performance over the range. Reference total clicks and impressions. Do NOT mention sessions, users, or conversions — GA4 data is unavailable.`,
    )
    lines.push(
      `3. "## Top queries" — 3–5 bullets, each referencing a specific query and its numbers.`,
    )
    lines.push(
      `4. "## Top pages" — 3–5 bullets interpreting which pages drive traffic and any noteworthy patterns.`,
    )
    lines.push(
      `5. "## Recommended actions" — exactly 2–3 bullets, each a concrete next-month action tied to a specific GSC pattern above.`,
    )
  }
  lines.push(
    `Do not include a preamble, do not apologize for missing data, do not add extra sections. Stay under 650 words total.`,
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
