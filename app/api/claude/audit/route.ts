import { NextResponse } from "next/server"
import { z } from "zod"
import { callClaude, ClaudeApiError } from "@/lib/claude"
import type {
  AuditSynthesis,
  BacklinkReport,
  CompetitiveReport,
  CrawlReport,
  AuditGa4Slice,
  AuditGscSlice,
  Prospect,
} from "@/lib/types"

export const dynamic = "force-dynamic"
export const maxDuration = 300

/**
 * Audit synthesis route.
 *
 * Model: `claude-sonnet-4-6`. Opus 4.7 was hitting stream-idle timeouts on
 * the large audit payload (crawl + competitive + backlinks + optional GSC/GA4
 * can be 30-40k input tokens); Sonnet 4.6 streams faster and has been
 * sufficient for this structured-output task in our testing. Keep an eye on
 * finding quality — if it regresses, swap back to Opus and solve the
 * timeout a different way (shorter prompt, chunked synthesis, etc.).
 */
const AUDIT_MODEL = "claude-sonnet-4-6"

// ────────────────────────────────────────────────────────────────────────────
// Request schema. Each sub-object is validated loosely (passthrough) because
// the intermediate audit routes are the source of truth for their shapes —
// we just need to pass everything through to the prompt.

const prospectSchema = z.object({
  domain: z.string(),
  targetMarkets: z.array(
    z.object({ city: z.string(), state: z.string() }),
  ),
  competitors: z.array(z.string()),
  gscSiteUrl: z.string().optional(),
  ga4PropertyId: z.string().optional(),
  contactName: z.string().optional(),
})

const bodySchema = z.object({
  prospect: prospectSchema,
  crawl: z.unknown(),
  competitive: z.unknown(),
  backlinks: z.unknown(),
  gsc: z.unknown().optional(),
  ga4: z.unknown().optional(),
})

interface ParsedBody {
  prospect: Prospect
  crawl: CrawlReport
  competitive: CompetitiveReport
  backlinks: BacklinkReport
  gsc?: AuditGscSlice
  ga4?: AuditGa4Slice
}

// ────────────────────────────────────────────────────────────────────────────
// Prompt assembly. Keep input tight — Sonnet is plenty smart if the data is
// well-labeled. We explicitly quantify: show counts, not prose descriptions.

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function formatPct(n: number): string {
  const sign = n >= 0 ? "+" : ""
  return `${sign}${n.toFixed(1)}%`
}

function pctDelta(current: number, prior: number): number {
  if (prior <= 0) return current > 0 ? 100 : 0
  return ((current - prior) / prior) * 100
}

function buildCrawlBlock(crawl: CrawlReport): string {
  const lines: string[] = []
  lines.push(`# Site crawl (${crawl.crawledCount} pages; sitemap reports ${crawl.sitemapUrls.length} URLs)`)
  lines.push(`Duration: ${Math.round(crawl.crawlDurationMs / 100) / 10}s. Max pages: ${crawl.maxPages}.`)
  lines.push(`Non-200 pages: ${crawl.nonOkPages.length}`)
  if (crawl.nonOkPages.length > 0) {
    for (const p of crawl.nonOkPages.slice(0, 10)) {
      lines.push(`  - ${p.status} ${truncate(p.url, 120)}`)
    }
  }
  lines.push(`Missing titles: ${crawl.missingTitles.length}`)
  for (const u of crawl.missingTitles.slice(0, 5)) lines.push(`  - ${truncate(u, 120)}`)
  lines.push(`Missing meta descriptions: ${crawl.missingDescriptions.length}`)
  for (const u of crawl.missingDescriptions.slice(0, 5)) lines.push(`  - ${truncate(u, 120)}`)
  lines.push(`Missing canonical tags: ${crawl.missingCanonicals.length}`)
  for (const u of crawl.missingCanonicals.slice(0, 5)) lines.push(`  - ${truncate(u, 120)}`)
  lines.push(`Duplicate title groups: ${crawl.duplicateTitles.length}`)
  for (const g of crawl.duplicateTitles.slice(0, 5)) {
    lines.push(`  - "${truncate(g.title, 80)}" on ${g.urls.length} pages: ${g.urls.slice(0, 3).map((u) => truncate(u, 80)).join(", ")}`)
  }
  lines.push(`Duplicate description groups: ${crawl.duplicateDescriptions.length}`)
  for (const g of crawl.duplicateDescriptions.slice(0, 5)) {
    lines.push(`  - "${truncate(g.description, 80)}" on ${g.urls.length} pages`)
  }
  lines.push(`Thin content pages (<300 words): ${crawl.thinContentPages.length}`)
  for (const p of crawl.thinContentPages.slice(0, 5)) {
    lines.push(`  - ${p.wordCount}w ${truncate(p.url, 120)}`)
  }
  lines.push(`Client-rendered SPA shells detected: ${crawl.spaShellPages.length}`)
  for (const u of crawl.spaShellPages.slice(0, 5)) lines.push(`  - ${truncate(u, 120)}`)
  lines.push(`Schema types present: ${crawl.schemaTypesPresent.join(", ") || "none"}`)
  lines.push(`Recommended schema types missing: ${crawl.schemaTypesRecommended.join(", ") || "none"}`)
  lines.push(`Image alt coverage: ${crawl.imageAltCoveragePercent}%`)
  return lines.join("\n")
}

function buildCompetitiveBlock(c: CompetitiveReport): string {
  const lines: string[] = []
  lines.push(`# Competitive visibility (state-level roll-up of target markets)`)
  if (c.competitorsAutoSuggested) {
    lines.push(`NOTE: Competitors were auto-suggested from SERP data — the MD did not supply them.`)
  }
  lines.push(`Target markets: ${c.markets.map((m) => `${m.city}, ${m.state}`).join("; ")}`)
  for (const row of c.rows) {
    lines.push("")
    lines.push(`## ${row.domain}${row.isProspect ? " (PROSPECT)" : ""}`)
    for (const m of row.markets) {
      lines.push(`  - ${m.city}, ${m.state}: ${m.organicKeywords} organic keywords, ${m.organicTraffic.toFixed(0)} est. monthly organic sessions, $${m.organicTrafficCost.toFixed(0)} est. traffic cost`)
      if (m.topKeywords.length > 0) {
        const top = m.topKeywords
          .map((k) => `"${k.keyword}" (pos ${k.position}, vol ${k.searchVolume})`)
          .join("; ")
        lines.push(`    top keywords: ${top}`)
      }
    }
  }
  return lines.join("\n")
}

function buildBacklinkBlock(b: BacklinkReport): string {
  const lines: string[] = []
  lines.push(`# Backlink profile`)
  lines.push(`Domain: ${b.domain}`)
  lines.push(`Total backlinks: ${b.totalBacklinks.toLocaleString()}`)
  lines.push(`Referring domains: ${b.referringDomains.toLocaleString()}`)
  lines.push(`Average spam score: ${b.averageSpamScore}`)
  lines.push(`Referring domains with spam score >= 50: ${b.highSpamCount}`)
  lines.push(`Top high-spam referring domain examples (use THESE exact domain names):`)
  if (b.highSpamExamples.length === 0) {
    lines.push(`  (none — no referring domains above spam score 50)`)
  }
  for (const s of b.highSpamExamples) {
    lines.push(`  - ${s.domain} (spam ${s.spamScore}, ${s.referringPages} referring pages)`)
  }
  lines.push(`Top authority referring domains for context:`)
  for (const s of b.topAuthorityExamples.slice(0, 5)) {
    lines.push(`  - ${s.domain} (rank ${s.rank})`)
  }
  return lines.join("\n")
}

function buildGscBlock(gsc: AuditGscSlice): string {
  const lines: string[] = []
  lines.push(`# Google Search Console (${gsc.dateRange.startDate} → ${gsc.dateRange.endDate})`)
  lines.push(`Site: ${gsc.siteUrl}`)
  lines.push(`Totals: ${gsc.totalClicks.toLocaleString()} clicks, ${gsc.totalImpressions.toLocaleString()} impressions`)
  lines.push("")
  lines.push(`## Top queries`)
  for (const q of gsc.topQueries.slice(0, 15)) {
    lines.push(`  - ${truncate(q.query, 80)} — ${q.clicks} clicks, ${q.impressions} impr, ${(q.ctr * 100).toFixed(2)}% CTR, pos ${q.position.toFixed(1)}`)
  }
  lines.push("")
  lines.push(`## Top pages`)
  for (const p of gsc.topPages.slice(0, 15)) {
    lines.push(`  - ${truncate(p.page, 100)} — ${p.clicks} clicks, ${p.impressions} impr, ${(p.ctr * 100).toFixed(2)}% CTR`)
  }
  return lines.join("\n")
}

function buildGa4Block(ga4: AuditGa4Slice): string {
  const lines: string[] = []
  const cur = ga4.current
  lines.push(`# Google Analytics 4 — current quarter ${cur.dateRange.startDate} → ${cur.dateRange.endDate}`)
  lines.push(`Sessions: ${cur.sessions.toLocaleString()}`)
  lines.push(`Users: ${cur.users.toLocaleString()}`)
  lines.push(`Conversions: ${cur.conversions.toLocaleString()} (conversions configured: ${cur.conversionsConfigured})`)
  if (ga4.prior) {
    const p = ga4.prior
    lines.push("")
    lines.push(`Prior-year quarter (${p.dateRange.startDate} → ${p.dateRange.endDate}): ${p.sessions.toLocaleString()} sessions, ${p.users.toLocaleString()} users, ${p.conversions.toLocaleString()} conversions`)
    lines.push(`YoY deltas: sessions ${formatPct(pctDelta(cur.sessions, p.sessions))}, users ${formatPct(pctDelta(cur.users, p.users))}, conversions ${formatPct(pctDelta(cur.conversions, p.conversions))}`)

    // Per-page YoY loss. Useful for "top pages to recover".
    const priorByPage = new Map(p.topLandingPages.map((lp) => [lp.landingPage, lp]))
    const losses: { page: string; current: number; prior: number; delta: number }[] = []
    for (const lp of cur.topLandingPages) {
      const prior = priorByPage.get(lp.landingPage)
      if (!prior) continue
      if (prior.sessions <= 10) continue
      const delta = pctDelta(lp.sessions, prior.sessions)
      if (delta < -5) {
        losses.push({ page: lp.landingPage, current: lp.sessions, prior: prior.sessions, delta })
      }
    }
    losses.sort((a, b) => a.delta - b.delta)
    if (losses.length > 0) {
      lines.push("")
      lines.push(`## Top landing pages that LOST sessions YoY`)
      for (const l of losses.slice(0, 10)) {
        lines.push(`  - ${truncate(l.page, 100)} — ${l.current} current vs. ${l.prior} prior (${formatPct(l.delta)})`)
      }
    }
  }

  if (cur.organicOnly.length > 0) {
    lines.push("")
    lines.push(`## Organic-search landing pages (current)`)
    for (const lp of cur.organicOnly.slice(0, 15)) {
      lines.push(`  - ${truncate(lp.landingPage, 100)} — ${lp.sessions} sessions, ${lp.conversions} conv, ${(lp.conversionRate * 100).toFixed(2)}% conv rate`)
    }
  }
  return lines.join("\n")
}

// ────────────────────────────────────────────────────────────────────────────
// The actual prompt.

const SYSTEM_PROMPT = `You are a senior SEO analyst producing a pre-sales audit for a prospective client of Harbinger Marketing. The audit will be delivered as a polished PDF sent directly to the prospect and the MD running the sales call.

HARD CONSTRAINTS (violations cause the audit to be rejected):
1. Produce EXACTLY 5–7 key findings. Not 8. Not 10. If more issues exist, pick the 7 with highest business impact and push the rest into appendix_issues as one-liners.
2. Every finding MUST cite a specific URL, count, or percentage taken VERBATIM from the data provided. Generic statements are forbidden.
3. At least ONE finding must reference a competitor domain by name to make the comparison concrete.
4. The backlink_risk section must list 3–5 actual spammy domain examples from the data (use the exact domain strings provided). If fewer than 3 high-spam domains exist in the data, say so honestly and list what does exist.
5. If GA4 conversion data is available and conversions are configured, traffic findings MUST translate to leads/revenue in plain language (e.g. "230 fewer organic sessions per month = roughly 9 fewer lead forms at the site's 4% conversion rate"). If GA4 is missing OR conversions are not configured, acknowledge the data gap rather than inventing a number.
6. No H/M/L priority labels unless tied to a concrete number (e.g. "affects pages representing 40% of organic sessions").
7. The 90-day roadmap must reference findings by number using the "#N" format (e.g. "Resolves Finding #3 — the 230 non-indexed pages").
8. No generic recommendations. "Optimize images" is forbidden. Say which images on which URLs and what the specific problem is.
9. If GA4 is not available: skip the traffic_analysis and top_pages_to_recover sections (set them to null) rather than fabricating data.

OUTPUT FORMAT: return ONLY a single JSON object (no preamble, no trailing text, no markdown fences) matching the schema provided in the user message. Ensure JSON is valid and parseable.`

function buildUserPrompt(body: ParsedBody): string {
  const { prospect, crawl, competitive, backlinks, gsc, ga4 } = body
  const lines: string[] = []

  lines.push(`# Prospect`)
  lines.push(`Domain: ${prospect.domain}`)
  if (prospect.contactName) lines.push(`Contact: ${prospect.contactName}`)
  lines.push(`Target markets: ${prospect.targetMarkets.map((m) => `${m.city}, ${m.state}`).join("; ")}`)
  lines.push(`Competitors provided: ${prospect.competitors.length > 0 ? prospect.competitors.join(", ") : "(none — auto-suggested)"}`)
  lines.push(`GSC access: ${gsc ? "yes" : "no"}`)
  lines.push(`GA4 access: ${ga4 ? "yes" : "no"}`)
  lines.push("")

  lines.push(buildCrawlBlock(crawl))
  lines.push("")
  lines.push(buildCompetitiveBlock(competitive))
  lines.push("")
  lines.push(buildBacklinkBlock(backlinks))
  if (gsc) {
    lines.push("")
    lines.push(buildGscBlock(gsc))
  }
  if (ga4) {
    lines.push("")
    lines.push(buildGa4Block(ga4))
  }

  lines.push("")
  lines.push(`# Output schema (return ONLY this JSON, no markdown fences, no preamble)`)
  lines.push("```json")
  lines.push(
    JSON.stringify(
      {
        prospectDomain: "<prospect domain, verbatim>",
        prospectName: "<optional prospect/contact name>",
        generatedAt: "<ISO 8601 timestamp>",
        executiveSummary:
          "<2-3 sentences. Set up the audit: what you looked at, the single most important conclusion. No fluff.>",
        keyFindings: [
          {
            number: 1,
            title: "<short, punchy>",
            detail: "<1-2 sentences. MUST cite URL, count, or %.>",
            headlineMetric: "<the single number that matters, e.g. '230 pages' or '-42%'>",
            businessImpact:
              "<optional. lead/revenue framing if GA4 conversions available; otherwise omit>",
          },
        ],
        appendixIssues: [
          "<one-line summaries of issues that didn't make the top 7>",
        ],
        trafficAnalysis: ga4
          ? {
              summary: "<1-2 sentence read of the YoY traffic story>",
              sessionsCurrent: 0,
              sessionsPrior: 0,
              sessionsDeltaPct: 0,
              conversionsCurrent: 0,
              conversionsPrior: 0,
              conversionsDeltaPct: 0,
              nuance:
                "<optional. 'Good news buried in bad' signal — e.g. engagement up while sessions down.>",
              topPagesLost: [
                { page: "<url>", sessionsLost: 0, deltaPct: 0 },
              ],
            }
          : null,
        keywordVisibility: {
          markets: [{ city: "<city>", state: "<state>" }],
          rows: [
            {
              domain: "<domain>",
              isProspect: false,
              perMarket: [
                {
                  city: "<city>",
                  state: "<state>",
                  organicKeywords: 0,
                  organicTraffic: 0,
                },
              ],
            },
          ],
          narrative:
            "<1-2 sentences naming at least one competitor domain and describing the visibility gap>",
        },
        topPagesToRecover: ga4
          ? [{ page: "<url>", reasoning: "<why this page matters>" }]
          : null,
        technicalFindings: [
          {
            title: "<short>",
            evidence: "<specific URL or count from the crawl data>",
            businessImpact: "<why the prospect should care in business terms>",
          },
        ],
        backlinkRisk: {
          summary: "<1-2 sentences>",
          averageSpamScore: 0,
          highSpamCount: 0,
          spamExamples: ["<exact spammy domain 1>", "<exact spammy domain 2>"],
        },
        roadmap: [
          {
            phase: "Month 1",
            title: "<short>",
            description:
              "<what gets done. MUST reference findings by #N, e.g. 'Resolves Finding #3'>",
            findingRefs: [3],
          },
          { phase: "Month 2", title: "", description: "", findingRefs: [] },
          { phase: "Month 3", title: "", description: "", findingRefs: [] },
        ],
        dataSources: {
          crawlPagesAnalyzed: 0,
          gscIncluded: Boolean(gsc),
          ga4Included: Boolean(ga4),
          competitorsAutoSuggested: competitive.competitorsAutoSuggested,
        },
      },
      null,
      2,
    ),
  )
  lines.push("```")

  return lines.join("\n")
}

// ────────────────────────────────────────────────────────────────────────────
// JSON extraction — Sonnet sometimes wraps output in ```json fences despite
// instructions. Strip fences, then parse.

function extractJson(text: string): unknown {
  const trimmed = text.trim()
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  const raw = fence ? fence[1] : trimmed
  return JSON.parse(raw)
}

// Loose validator — we trust Claude's structural output but defensively check
// the two hard-limit invariants (5-7 findings, every finding has the
// required fields). If they're violated, return a 502 with a useful message
// so the UI can retry rather than crashing the PDF render.
function validateSynthesis(parsed: unknown): AuditSynthesis {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Claude output was not a JSON object")
  }
  const obj = parsed as AuditSynthesis
  if (!Array.isArray(obj.keyFindings)) {
    throw new Error("keyFindings missing or not an array")
  }
  if (obj.keyFindings.length < 5 || obj.keyFindings.length > 7) {
    throw new Error(
      `keyFindings must have 5–7 entries, got ${obj.keyFindings.length}`,
    )
  }
  for (const f of obj.keyFindings) {
    if (typeof f.number !== "number" || !f.title || !f.detail || !f.headlineMetric) {
      throw new Error("a keyFinding is missing number/title/detail/headlineMetric")
    }
  }
  if (!obj.keywordVisibility || typeof obj.keywordVisibility.narrative !== "string") {
    throw new Error("keywordVisibility.narrative missing")
  }
  if (!obj.backlinkRisk || !Array.isArray(obj.backlinkRisk.spamExamples)) {
    throw new Error("backlinkRisk.spamExamples missing")
  }
  if (!Array.isArray(obj.roadmap) || obj.roadmap.length === 0) {
    throw new Error("roadmap missing or empty")
  }
  return obj
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

  const body = parsed.data as unknown as ParsedBody

  try {
    const prompt = buildUserPrompt(body)
    const text = await callClaude(prompt, {
      model: AUDIT_MODEL,
      system: SYSTEM_PROMPT,
      maxTokens: 6_000,
    })

    let parsedJson: unknown
    try {
      parsedJson = extractJson(text)
    } catch (err) {
      console.error(
        "[api/claude/audit] failed to parse JSON from Claude output:",
        err,
        "\nRaw output start:\n",
        text.slice(0, 500),
      )
      return NextResponse.json(
        { error: "Claude output was not valid JSON. Retry the audit." },
        { status: 502 },
      )
    }

    let synthesis: AuditSynthesis
    try {
      synthesis = validateSynthesis(parsedJson)
    } catch (err) {
      console.error(
        "[api/claude/audit] synthesis failed schema check:",
        err,
        "\nParsed keys:",
        Object.keys(parsedJson as object ?? {}),
      )
      return NextResponse.json(
        {
          error:
            err instanceof Error
              ? `Audit synthesis invalid: ${err.message}. Retry the audit.`
              : "Audit synthesis invalid. Retry the audit.",
        },
        { status: 502 },
      )
    }

    synthesis.generatedAt = synthesis.generatedAt ?? new Date().toISOString()

    return NextResponse.json({ synthesis })
  } catch (error) {
    console.error("[api/claude/audit] failed:", error)
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
