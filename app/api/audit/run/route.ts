import { NextResponse } from "next/server"
import { z } from "zod"
import { detectCannibalization } from "@/lib/cannibalization"
import { callClaude, ClaudeApiError } from "@/lib/claude"
import { crawlSite } from "@/lib/crawler"
import { GA4Error, getMonthlyOrganic, getSeoReport } from "@/lib/ga4"
import { findGa4PropertyCandidates } from "@/lib/ga4-site-match"
import { listProperties } from "@/lib/ga4"
import { emailFor } from "@/lib/google-auth"
import {
  GSCError,
  getDailyClicks,
  getIndexCoverage,
  getQueries,
  getTopPages,
  getTopPagesPaginated,
  getTopQueriesPaginated,
  listSites,
  partnerWebsiteToGscSiteUrl,
} from "@/lib/gsc"
import { findGscSiteCandidates } from "@/lib/gsc-site-match"
import type {
  AssessmentAuditResult,
  AssessmentGa4Data,
  AssessmentGscData,
  AuditCrawlSummary,
  CannibalizationCluster,
  CrawlReport,
  GSCQueryRow,
} from "@/lib/types"

/**
 * Assessment Audit endpoint.
 *
 * Stateless. Always pre-sales mode (manual inputs only — no Airtable
 * lookup). Uses the assessments Google account exclusively. Returns the
 * full result as JSON, including a markdown narrative the front-end can
 * render and download. There is no DB; refreshing the page wipes state.
 *
 * Sequence:
 *   1. Validate inputs (websiteUrl + at least one targetMarket required)
 *   2. Fetch GSC + GA4 (assessments token), tolerating both being absent
 *   3. Crawl the site
 *   4. Synthesize markdown via Claude (claude-opus-4-7)
 *   5. Return { auditMarkdown, gscData, ga4Data, crawlSummary, warnings }
 */
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

const targetMarketSchema = z.object({
  city: z.string().min(1),
  state: z.string().min(1),
})

const bodySchema = z.object({
  websiteUrl: z.string().min(3),
  partnerName: z.string().optional().default(""),
  priorityServices: z.string().optional().default(""),
  negativeKeywords: z.string().optional().default(""),
  existingTargetKeywords: z.string().optional().default(""),
  idealCustomer: z.string().optional().default(""),
  /** "City, ST" preferred; objects work too if the client already split them. */
  targetMarkets: z.array(targetMarketSchema).min(1).max(10),
  /**
   * `"full"` (default) crawls every URL in the sitemap; `"sample"` caps at
   * 50 prioritized URLs for fast testing.
   */
  crawlMode: z.enum(["full", "sample"]).optional().default("full"),
})

type Body = z.infer<typeof bodySchema>

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}
function isoDaysAgo(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  return fmtDate(d)
}
function isoMonthsAgo(months: number): string {
  const d = new Date()
  d.setUTCMonth(d.getUTCMonth() - months)
  return fmtDate(d)
}

function cleanWebsite(raw: string): string {
  return raw.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase()
}

interface GscFetchResult {
  data: AssessmentGscData
  /** Long-range [query, page] export used by the cannibalization detector. */
  queryPages: GSCQueryRow[]
}

async function tryFetchGsc(
  websiteUrl: string,
  warnings: string[],
): Promise<GscFetchResult | null> {
  let siteUrl: string | null = null
  try {
    const sites = await listSites("assessments")
    const matches = findGscSiteCandidates(websiteUrl, sites)
    siteUrl = matches[0]?.siteUrl ?? partnerWebsiteToGscSiteUrl(websiteUrl)
  } catch (err) {
    if (err instanceof GSCError && err.code === "NO_REFRESH_TOKEN") {
      warnings.push(
        `GSC: ${err.message}. The audit will continue using crawl data only.`,
      )
      return null
    }
    warnings.push(
      `GSC: failed to list sites for the assessments account (${emailFor("assessments")}). The audit will continue without GSC.`,
    )
    return null
  }

  const startDate = isoMonthsAgo(16)
  const endDate = isoDaysAgo(2)
  try {
    const [topQueries, topPages, dailyClicks, queryPages] = await Promise.all([
      getTopQueriesPaginated({
        account: "assessments",
        siteUrl,
        startDate,
        endDate,
        maxRows: 100,
      }),
      getTopPagesPaginated({
        account: "assessments",
        siteUrl,
        startDate,
        endDate,
        maxRows: 50,
      }),
      getDailyClicks({
        account: "assessments",
        siteUrl,
        startDate,
        endDate,
      }),
      // [query, page] export — feeds the SERP-overlap signal in the
      // cannibalization detector. Capped at one API call (5k rows) since
      // ranking pages with positions in the top 20 don't need a deep tail.
      getQueries({
        account: "assessments",
        siteUrl,
        startDate,
        endDate,
        rowLimit: 5000,
      }).catch(() => [] as GSCQueryRow[]),
    ])
    const totalClicks = dailyClicks.reduce((s, d) => s + d.clicks, 0)
    const totalImpressions = dailyClicks.reduce((s, d) => s + d.impressions, 0)
    return {
      data: {
        siteUrl,
        dateRange: { startDate, endDate },
        totalClicks,
        totalImpressions,
        topQueries,
        topPages,
        dailyClicks,
        indexCoverage: null,
      },
      queryPages,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown GSC error"
    warnings.push(
      `GSC access not yet granted for this property. Please ensure ${emailFor("assessments")} has been added as a user on Search Console. The audit will continue using crawl data only. (${msg})`,
    )
    return null
  }
}

/**
 * Compute the 90-day indexation-coverage proxy. Sequenced after the crawl
 * because we need `crawl.sitemapUrls`. Errors are non-fatal: a warning is
 * pushed and the audit continues without indexation data.
 */
async function tryFetchIndexCoverage(
  gsc: AssessmentGscData,
  sitemapUrls: string[],
  warnings: string[],
): Promise<void> {
  if (sitemapUrls.length === 0) return
  const startDate = isoDaysAgo(90)
  const endDate = isoDaysAgo(2)
  try {
    // GSC search analytics: pages-only, last 90 days. We pull a wide rowLimit
    // because the 90-day list of pages-with-impressions is the entire denom
    // for "is this URL being seen". Rate-limit cap is 25,000 in one call.
    const recentPages = await getTopPages({
      account: "assessments",
      siteUrl: gsc.siteUrl,
      startDate,
      endDate,
      rowLimit: 25_000,
    })
    const coverage = await getIndexCoverage({
      account: "assessments",
      siteUrl: gsc.siteUrl,
      sitemapUrls,
      gscPages: recentPages,
      dateRange: { startDate, endDate },
    })
    gsc.indexCoverage = coverage
    console.log(
      `[audit:index-coverage] site=${gsc.siteUrl} sitemap=${coverage.sitemapCount} indexed=${coverage.indexedUrls.length} probably_not_indexed=${coverage.probablyNotIndexed.length} inspected=${coverage.inspectedSample.length}`,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error"
    warnings.push(
      `Indexation coverage check failed; the audit will continue without indexation data. (${msg})`,
    )
  }
}

async function tryFetchGa4(
  websiteUrl: string,
  warnings: string[],
): Promise<AssessmentGa4Data | null> {
  let propertyId: string | null = null
  try {
    const properties = await listProperties({ account: "assessments" })
    const matches = findGa4PropertyCandidates(websiteUrl, properties)
    propertyId = matches[0]?.propertyId ?? null
  } catch (err) {
    if (err instanceof GA4Error && err.code === "NO_REFRESH_TOKEN") {
      warnings.push(
        `GA4: ${err.message}. The audit will continue without GA4.`,
      )
      return null
    }
    warnings.push(
      `GA4: failed to list properties for the assessments account (${emailFor("assessments")}). The audit will continue without GA4.`,
    )
    return null
  }
  if (!propertyId) {
    warnings.push(
      `GA4 access not yet granted for this property. Please ensure ${emailFor("assessments")} has been added as a Viewer on the GA4 property. The audit will continue using GSC + crawl data only.`,
    )
    return null
  }

  const today = new Date()
  const endDate = fmtDate(today)
  const startD = new Date(today)
  startD.setUTCFullYear(startD.getUTCFullYear() - 1)
  startD.setUTCDate(startD.getUTCDate() + 1)
  const startDate = fmtDate(startD)

  try {
    const [report, monthlyOrganic] = await Promise.all([
      getSeoReport({ account: "assessments", propertyId, startDate, endDate }),
      getMonthlyOrganic({
        account: "assessments",
        propertyId,
        startDate,
        endDate,
      }).catch(() => []),
    ])
    return {
      propertyId,
      dateRange: { startDate, endDate },
      sessions: report.sessions,
      users: report.users,
      conversions: report.conversions,
      conversionsConfigured: report.conversionsConfigured,
      organicLandingPages: report.organicOnly,
      channelBreakdown: [],
      monthlyOrganic,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown GA4 error"
    warnings.push(`GA4 fetch failed for property ${propertyId}: ${msg}`)
    return null
  }
}

function summarizeCrawl(crawl: CrawlReport): AuditCrawlSummary {
  return {
    domain: crawl.domain,
    pagesAnalyzed: crawl.crawledCount,
    durationMs: crawl.crawlDurationMs,
    missingTitles: crawl.missingTitles.length,
    missingDescriptions: crawl.missingDescriptions.length,
    duplicateTitles: crawl.duplicateTitles.length,
    duplicateDescriptions: crawl.duplicateDescriptions.length,
    thinContentPages: crawl.thinContentPages.length,
    spaShellPages: crawl.spaShellPages.length,
    schemaTypesPresent: crawl.schemaTypesPresent,
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function buildPrompt(params: {
  body: Body
  gsc: AssessmentGscData | null
  ga4: AssessmentGa4Data | null
  crawl: CrawlReport
  cannibalization: CannibalizationCluster[]
}): string {
  const { body, gsc, ga4, crawl, cannibalization } = params
  const lines: string[] = []

  lines.push(`# Prospect business context`)
  lines.push(`Website: ${body.websiteUrl}`)
  lines.push(`Priority services:\n${body.priorityServices || "(none provided)"}`)
  lines.push(
    `Services / terms to exclude:\n${body.negativeKeywords || "(none provided)"}`,
  )
  lines.push(
    `Existing target keywords (one per line):\n${body.existingTargetKeywords || "(none provided)"}`,
  )
  lines.push(
    `Ideal customer & problems they need solved:\n${body.idealCustomer || "(none provided)"}`,
  )
  lines.push(
    `Target locations: ${body.targetMarkets.map((m) => `${m.city}, ${m.state}`).join("; ")}`,
  )
  lines.push("")

  // GSC summary.
  if (gsc) {
    lines.push(`# Google Search Console (last 16 months)`)
    lines.push(`Site: ${gsc.siteUrl}`)
    lines.push(
      `Window: ${gsc.dateRange.startDate} → ${gsc.dateRange.endDate}`,
    )
    lines.push(
      `Totals: ${gsc.totalClicks.toLocaleString()} clicks, ${gsc.totalImpressions.toLocaleString()} impressions`,
    )
    lines.push("")
    lines.push(`## Top queries by impressions (top 50)`)
    const queries = [...gsc.topQueries]
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 50)
    for (const q of queries) {
      lines.push(
        `  - ${truncate(q.query, 70)} — ${q.clicks} clicks, ${q.impressions.toLocaleString()} impr, ${(q.ctr * 100).toFixed(2)}% CTR, pos ${q.position.toFixed(1)}`,
      )
    }
    lines.push("")
    lines.push(`## Top pages by impressions (top 25)`)
    const pages = [...gsc.topPages]
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 25)
    for (const p of pages) {
      lines.push(
        `  - ${truncate(p.page, 100)} — ${p.clicks.toLocaleString()} clicks, ${p.impressions.toLocaleString()} impr, ${(p.ctr * 100).toFixed(2)}% CTR, pos ${p.position.toFixed(1)}`,
      )
    }
    lines.push("")

    // Indexation-coverage proxy (last 90 days). Surfaced in its own section
    // so Claude can apply the Tier 1 rule without re-deriving the math.
    if (gsc.indexCoverage) {
      const cov = gsc.indexCoverage
      const sitemapPct =
        cov.sitemapCount > 0
          ? (cov.probablyNotIndexed.length / cov.sitemapCount) * 100
          : 0
      const tierOne =
        cov.probablyNotIndexed.length > 20 || sitemapPct > 10
      lines.push(
        `## Indexation coverage (last 90 days — ${cov.dateRange.startDate} → ${cov.dateRange.endDate})`,
      )
      lines.push(`Sitemap URLs: ${cov.sitemapCount.toLocaleString()}`)
      lines.push(
        `Indexed (≥1 impression in window): ${cov.indexedUrls.length.toLocaleString()}`,
      )
      lines.push(
        `Probably NOT indexed (zero impressions): ${cov.probablyNotIndexed.length.toLocaleString()} (${sitemapPct.toFixed(1)}% of sitemap)`,
      )
      lines.push(
        `Tier 1 indexation-gap finding required: ${tierOne ? "YES — must appear in Key Findings AND Executive Summary" : "no"}`,
      )
      if (cov.probablyNotIndexed.length > 0) {
        lines.push(``)
        lines.push(`### Sample of probably-not-indexed sitemap URLs (first 25)`)
        for (const u of cov.probablyNotIndexed.slice(0, 25)) {
          lines.push(`  - ${truncate(u, 140)}`)
        }
      }
      if (cov.inspectedSample.length > 0) {
        lines.push(``)
        lines.push(
          `### URL Inspection results (up to ${cov.inspectedSample.length} confirmed via Search Console)`,
        )
        for (const s of cov.inspectedSample) {
          if (s.error) {
            lines.push(
              `  - ${truncate(s.url, 120)} — inspection failed: ${s.error}`,
            )
            continue
          }
          const parts = [
            `coverage="${s.coverageState ?? "unknown"}"`,
            `verdict=${s.verdict ?? "n/a"}`,
            `pageFetchState=${s.pageFetchState ?? "n/a"}`,
            `lastCrawl=${s.lastCrawlTime ?? "never"}`,
          ]
          lines.push(`  - ${truncate(s.url, 100)} — ${parts.join(", ")}`)
        }
      }
      lines.push("")
    }
  } else {
    lines.push(`# Google Search Console`)
    lines.push(
      `Not connected for the assessments account. Acknowledge this gap explicitly in the executive summary.`,
    )
    lines.push("")
  }

  // GA4 summary.
  if (ga4) {
    lines.push(
      `# Google Analytics 4 (last 12 months — ${ga4.dateRange.startDate} → ${ga4.dateRange.endDate})`,
    )
    lines.push(`Sessions: ${ga4.sessions.toLocaleString()}`)
    lines.push(`Users: ${ga4.users.toLocaleString()}`)
    lines.push(
      `Conversions: ${ga4.conversions.toLocaleString()} (configured: ${ga4.conversionsConfigured})`,
    )
    lines.push("")
    lines.push(`## Monthly organic sessions`)
    for (const m of ga4.monthlyOrganic) {
      lines.push(
        `  - ${m.month}: ${m.sessions.toLocaleString()} sessions, ${m.conversions.toLocaleString()} conversions`,
      )
    }
    lines.push("")
    lines.push(`## Top organic landing pages (last 12 months)`)
    for (const lp of ga4.organicLandingPages.slice(0, 25)) {
      lines.push(
        `  - ${truncate(lp.landingPage, 100)} — ${lp.sessions.toLocaleString()} sess, ${lp.conversions.toLocaleString()} conv, ${(lp.conversionRate * 100).toFixed(2)}% rate`,
      )
    }
    lines.push("")
  } else {
    lines.push(`# Google Analytics 4`)
    lines.push(
      `Not connected for the assessments account. Frame conversion / business-impact commentary as a known data gap.`,
    )
    lines.push("")
  }

  // Crawl summary.
  lines.push(`# Site crawl`)
  lines.push(
    `Pages analyzed: ${crawl.crawledCount} (sitemap reports ${crawl.sitemapUrls.length} URLs; mode=${crawl.mode})`,
  )
  const distEntries = Object.entries(crawl.statusCodeDistribution).sort(
    (a, b) => b[1] - a[1],
  )
  lines.push(
    `Status code distribution: ${
      distEntries.length > 0
        ? distEntries.map(([code, n]) => `${code}: ${n}`).join(", ")
        : "(no responses)"
    }`,
  )
  lines.push(`Non-200 pages: ${crawl.nonOkPages.length}`)
  for (const p of crawl.nonOkPages.slice(0, 10)) {
    lines.push(`  - ${p.status} ${truncate(p.url, 120)}`)
  }
  lines.push(`Pages missing titles: ${crawl.missingTitles.length}`)
  for (const u of crawl.missingTitles.slice(0, 5)) {
    lines.push(`  - ${truncate(u, 120)}`)
  }
  lines.push(`Pages missing meta descriptions: ${crawl.missingDescriptions.length}`)
  lines.push(`Pages with no canonical tag: ${crawl.missingCanonicals.length}`)
  lines.push(
    `Pages with no meaningful schema (no JSON-LD beyond Article/Person/ImageObject): ${crawl.pagesMissingMeaningfulSchema}`,
  )
  lines.push(`Duplicate title groups: ${crawl.duplicateTitles.length}`)
  for (const g of crawl.duplicateTitles.slice(0, 5)) {
    lines.push(
      `  - "${truncate(g.title, 80)}" on ${g.urls.length} pages: ${g.urls.slice(0, 3).map((u) => truncate(u, 80)).join(", ")}`,
    )
  }
  lines.push(`Duplicate description groups: ${crawl.duplicateDescriptions.length}`)
  lines.push(`Thin content pages (<300 words): ${crawl.thinContentPages.length}`)
  lines.push(`SPA shells detected: ${crawl.spaShellPages.length}`)
  lines.push(
    `Schema types present: ${crawl.schemaTypesPresent.join(", ") || "none"}`,
  )
  lines.push(
    `Recommended schema types missing: ${crawl.schemaTypesRecommended.join(", ") || "none"}`,
  )
  lines.push(`Image alt coverage: ${crawl.imageAltCoveragePercent}%`)
  lines.push("")

  // Cannibalization clusters — pre-computed by lib/cannibalization.ts so
  // Claude doesn't have to re-derive them from the title list. Only emit the
  // section when there's at least one cluster; absence is meaningful too,
  // but mentioning "no clusters" in the prompt invites Claude to fabricate.
  if (cannibalization.length > 0) {
    lines.push(`# Keyword cannibalization clusters`)
    lines.push(
      `${cannibalization.length} cluster(s) of pages competing for the same keyword/location combination.`,
    )
    cannibalization.forEach((c, i) => {
      const head = `Cluster ${i + 1} (signal: ${c.sharedSignal}, recommendation hint: ${c.recommendationHint})`
      lines.push(head)
      if (c.topQuery) lines.push(`  shared query: "${c.topQuery}"`)
      if (c.sharedTitle) lines.push(`  shared title: "${truncate(c.sharedTitle, 100)}"`)
      for (const url of c.cluster) {
        lines.push(`  - ${truncate(url, 140)}`)
      }
    })
    lines.push("")
  }

  return lines.join("\n")
}

const SYSTEM_PROMPT = `You are a senior SEO analyst producing an SEO audit for a prospective Harbinger Marketing partner. Output is read in-app and exported to markdown — render the audit as well-structured Markdown.

Rules for prioritization (apply silently — surface findings, not the rules):
1. Findings related to the priority services and target locations get surfaced first within each section.
2. Findings related to excluded services / negative keywords are de-prioritized; flag them only when they are actively cannibalizing the priority services.
3. Where GSC shows the site already ranking for keywords related to priority services, lead with optimization recommendations rather than new-page recommendations.
4. Where target locations have no corresponding location pages or GSC visibility, flag this as a gap.
5. Do NOT invent data. If the crawl, GSC, or GA4 data does not support a recommendation, do not make it.
6. When GSC or GA4 is absent, acknowledge the gap honestly in the executive summary rather than fabricating numbers.
7. Indexation gap is a Tier 1 priority. When the "Indexation coverage" section reports "Tier 1 indexation-gap finding required: YES" (i.e. probably_not_indexed > 20 URLs OR > 10% of sitemap), you MUST:
   (a) include an indexation-gap finding in the Key Findings list with a bolded headline metric of the form "**X of Y sitemap URLs (Z%) have not received a single impression in 90 days**",
   (b) cite at least 2-3 specific URLs from the "Sample of probably-not-indexed sitemap URLs" list,
   (c) reference the URL Inspection results when present (e.g. "Search Console confirms coverage state 'Crawled - currently not indexed' on the inspected sample"), and
   (d) name the indexation gap explicitly in the Executive Summary — this is the single highest-impact finding type for partner sites.
   When the rule is not triggered, only mention indexation if the data warrants it.

Output format (Markdown):

# SEO Audit — <prospect domain>

## Executive Summary
2-4 sentences. Lead with the single most important conclusion. If GSC or GA4 is absent, name the gap explicitly.

## Key Findings
5-7 numbered findings, each cites a specific URL, count, percentage, or query taken VERBATIM from the data. Generic findings are forbidden. Each finding has a one-line headline metric in **bold**.

## Traffic & Visibility
Read of the GSC + GA4 data. Highlight the priority-service queries the site already ranks for (lead with these), and the target locations with no visibility (flag these). If GA4 conversions are configured, translate traffic gaps to leads/revenue in plain language. If not, say so.

## Technical Findings
Specific issues from the crawl, ordered by impact. Cite exact pages.

## Target Location Coverage
One short row per target location: does the site have a corresponding page? Is it ranking? Use the data provided.

## Keyword Cannibalization
ONLY include this section when the prompt contains a "# Keyword cannibalization clusters" block. Render it as a top-level audit section with one subsection per cluster. For each cluster:
- List the competing URLs verbatim from the prompt.
- Name the shared signal (identical title, title similarity, URL pattern, or SERP overlap) and, if present, quote the shared query / title.
- Recommend a winning URL based on the strongest signal in the data — prefer the page with more GSC clicks if known, otherwise the better-ranked page, otherwise the page with the longer / more linked URL. Be explicit ("Keep <URL>; 301 redirect <URL> and <URL>").
- For clusters with the recommendation hint "differentiate_intent", recommend rewriting titles/intent rather than redirecting; for "consolidate_to_stronger", recommend a 301 redirect.
Do NOT invent clusters that aren't in the prompt block. When the block is absent, omit this section entirely.

## 90-Day Roadmap
Month 1 / Month 2 / Month 3, each with 2-3 specific actions. Reference key findings by number ("Resolves Finding #3").

## Appendix: Other Issues
One-liners for issues that didn't make the top findings. Optional.

Constraints:
- Do NOT include partner profile boilerplate.
- Do NOT cite industry CTR averages — use the prospect's own GSC data.
- Every recommendation specifies the exact pages, queries, and metrics being addressed.
- Length: aim for 800-1500 words of finished prose.`

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
  const body: Body = parsed.data

  const startedAt = Date.now()
  const warnings: string[] = []
  const websiteUrl = cleanWebsite(body.websiteUrl)

  let gsc: AssessmentGscData | null = null
  let gscQueryPages: GSCQueryRow[] = []
  let ga4: AssessmentGa4Data | null = null
  let crawl: CrawlReport
  try {
    const [gscRes, ga4Res, crawlRes] = await Promise.all([
      tryFetchGsc(websiteUrl, warnings),
      tryFetchGa4(websiteUrl, warnings),
      crawlSite({
        domain: websiteUrl,
        options: { mode: body.crawlMode },
      }),
    ])
    gsc = gscRes?.data ?? null
    gscQueryPages = gscRes?.queryPages ?? []
    ga4 = ga4Res
    crawl = crawlRes
    if (gsc) {
      await tryFetchIndexCoverage(gsc, crawl.sitemapUrls, warnings)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error"
    return NextResponse.json(
      { error: `Audit data fetch failed: ${msg}` },
      { status: 500 },
    )
  }

  const cannibalization = detectCannibalization({
    pages: crawl.pages,
    partnerName: body.partnerName?.trim() || null,
    gscQueryPages,
    targetMarkets: body.targetMarkets,
  })
  console.log(
    `[audit:cannibalization] domain=${websiteUrl} clusters=${cannibalization.length} pages=${crawl.pages.length} gsc_query_pages=${gscQueryPages.length}`,
  )

  let auditMarkdown: string
  try {
    const prompt = buildPrompt({ body, gsc, ga4, crawl, cannibalization })
    auditMarkdown = await callClaude(prompt, {
      model: "claude-opus-4-7",
      system: SYSTEM_PROMPT,
      maxTokens: 12_000,
    })
  } catch (err) {
    if (err instanceof ClaudeApiError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.status ?? 502 },
      )
    }
    const msg = err instanceof Error ? err.message : "Unknown error"
    return NextResponse.json(
      { error: `Claude synthesis failed: ${msg}` },
      { status: 502 },
    )
  }

  const durationSeconds = Math.round((Date.now() - startedAt) / 1000)
  const result: AssessmentAuditResult = {
    websiteUrl,
    generatedAt: new Date().toISOString(),
    auditMarkdown,
    warnings,
    gscData: gsc,
    ga4Data: ga4,
    crawlSummary: summarizeCrawl(crawl),
    cannibalization,
    durationSeconds,
  }
  return NextResponse.json(result)
}
