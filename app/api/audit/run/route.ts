import { NextResponse } from "next/server"
import { z } from "zod"
import {
  buildSeries as buildOrganicSeries,
  renderOrganicSessionsBlock,
  renderOrganicSessionsSparklineSvg,
} from "@/lib/audit-chart"
import {
  detectBrokenInternalLinks,
  type BrokenInternalLinks,
} from "@/lib/audit-broken-links"
import {
  detectUrlStructureIssues,
  type UrlStructureIssues,
} from "@/lib/audit-url-structure"
import { detectCannibalization } from "@/lib/cannibalization"
import { callClaude, ClaudeApiError } from "@/lib/claude"
import { crawlSite } from "@/lib/audit-crawl"
import { backlinkProfile } from "@/lib/dataforseo"
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
import { runPageSpeedAudit } from "@/lib/pagespeed"
import type {
  AssessmentAuditResult,
  AssessmentGa4Data,
  AssessmentGscData,
  AuditCrawlSummary,
  BacklinkProfile,
  CannibalizationCluster,
  CrawlReport,
  GSCQueryRow,
  PageSpeedReport,
} from "@/lib/types"

/**
 * Per-location competitor snippets are still on the roadmap (Step 7) — the
 * synthesis prompt accepts them as optional. URL structure and broken-
 * internal-link detection are computed inline by `detectUrlStructureIssues`
 * and `detectBrokenInternalLinks` from the existing crawl output.
 */
export interface LocationCompetitorSnippet {
  city: string
  state: string
  prospectOrganicTraffic: number
  topCompetitors: {
    domain: string
    organicTraffic: number
    organicKeywords: number
    sampleQueries: { query: string; position: number; searchVolume: number }[]
  }[]
}

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
export const maxDuration = 800

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

  // Monthly organic powers the YoY chart, which needs the most recent 12
  // months PLUS the prior 12 for comparison. GA4 returns whatever exists in
  // the window; if a property is younger than 24 months, the prior series
  // is just shorter — the chart util handles that gracefully.
  const monthlyStartD = new Date(today)
  monthlyStartD.setUTCFullYear(monthlyStartD.getUTCFullYear() - 2)
  monthlyStartD.setUTCDate(monthlyStartD.getUTCDate() + 1)
  const monthlyStartDate = fmtDate(monthlyStartD)

  try {
    const [report, monthlyOrganic] = await Promise.all([
      getSeoReport({ account: "assessments", propertyId, startDate, endDate }),
      getMonthlyOrganic({
        account: "assessments",
        propertyId,
        startDate: monthlyStartDate,
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

function truncatePsiUrl(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function buildPageSpeedSection(report: PageSpeedReport): string[] {
  const lines: string[] = []
  if (report.skippedReason) {
    lines.push(`# PageSpeed Insights`)
    lines.push(report.skippedReason)
    lines.push("")
    return lines
  }
  if (report.pages.length === 0) return lines

  const a = report.aggregates
  lines.push(`# PageSpeed Insights (mobile-first; Google ranks on mobile)`)
  lines.push(
    `Pages audited: ${report.pages.length} (top GSC pages by impressions${report.homepageIncluded ? " + homepage" : ""})`,
  )
  lines.push(
    `Average mobile performance score: ${a.averageMobileScore ?? "n/a"}/100`,
  )
  lines.push(
    `Homepage mobile performance score: ${a.homepageMobileScore ?? "n/a"}/100`,
  )
  if (typeof a.homepageMobileScore === "number" && a.homepageMobileScore < 50) {
    lines.push(
      `Tier 1 performance finding required: YES — homepage mobile performance is below 50. Surface in Executive Summary AND Key Findings.`,
    )
  }

  const anyBelow70 = report.pages.some(
    (p) =>
      typeof p.mobile?.performanceScore === "number" &&
      p.mobile.performanceScore < 70,
  )
  lines.push(
    `Performance section required: ${anyBelow70 ? "YES — at least one audited page has mobile score < 70" : "no"}`,
  )

  if (a.lowScorePages.length > 0) {
    lines.push("")
    lines.push(`## Pages with mobile performance score < 50`)
    for (const p of a.lowScorePages) {
      lines.push(`  - ${truncatePsiUrl(p.url, 120)} — score ${p.score}/100`)
    }
  }
  if (a.poorLcpPages.length > 0) {
    lines.push("")
    lines.push(`## Pages with mobile LCP > 2.5s`)
    for (const p of a.poorLcpPages) {
      lines.push(
        `  - ${truncatePsiUrl(p.url, 120)} — LCP ${(p.lcpMs / 1000).toFixed(2)}s`,
      )
    }
  }
  if (a.poorClsPages.length > 0) {
    lines.push("")
    lines.push(`## Pages with mobile CLS > 0.1`)
    for (const p of a.poorClsPages) {
      lines.push(`  - ${truncatePsiUrl(p.url, 120)} — CLS ${p.cls.toFixed(3)}`)
    }
  }

  lines.push("")
  lines.push(`## Per-page mobile metrics`)
  for (const p of report.pages) {
    const m = p.mobile
    if (!m) {
      lines.push(`  - ${truncatePsiUrl(p.url, 120)} — mobile data unavailable`)
      continue
    }
    const lcp = typeof m.lcpMs === "number" ? `${(m.lcpMs / 1000).toFixed(2)}s` : "n/a"
    const inp = typeof m.inpMs === "number" ? `${m.inpMs}ms` : "n/a"
    const cls = typeof m.cls === "number" ? m.cls.toFixed(3) : "n/a"
    const ttfb = typeof m.ttfbMs === "number" ? `${m.ttfbMs}ms` : "n/a"
    const score = typeof m.performanceScore === "number" ? `${m.performanceScore}/100` : "n/a"
    lines.push(
      `  - ${truncatePsiUrl(p.url, 100)} — score ${score}, LCP ${lcp}, INP ${inp}, CLS ${cls}, TTFB ${ttfb}`,
    )
    if (m.opportunities.length > 0) {
      const opps = m.opportunities
        .map(
          (o) =>
            `${o.title}${typeof o.estimatedSavingsMs === "number" ? ` (save ~${(o.estimatedSavingsMs / 1000).toFixed(2)}s)` : ""}`,
        )
        .join("; ")
      lines.push(`      top opportunities: ${opps}`)
    }
  }
  lines.push("")
  return lines
}

/**
 * Compute the gating shares the prompt + Claude both reason about. Mirrors
 * the helper in `app/api/claude/audit/route.ts` so the Tier-1 trigger is the
 * single source of truth.
 */
function backlinkProfileShares(p: BacklinkProfile): {
  lowQualityShare: number
  newLinkLowQualityShare: number
  sectionRequired: boolean
  tier1: boolean
} {
  const lowQualityShare =
    p.totalReferringDomains > 0
      ? p.lowQualityDomains / p.totalReferringDomains
      : 0
  const newLinkLowQualityShare =
    p.newLinksLast12Months > 0
      ? p.newLinksLast12MonthsLowQuality / p.newLinksLast12Months
      : 0
  // Section required when either share is meaningful; Tier 1 fires once the
  // new-link low-quality share crosses 40% (the threshold in the user-facing
  // prioritization rules).
  const sectionRequired = lowQualityShare > 0.3 || newLinkLowQualityShare > 0.4
  const tier1 = newLinkLowQualityShare > 0.4
  return { lowQualityShare, newLinkLowQualityShare, sectionRequired, tier1 }
}

function buildBacklinkProfileSection(p: BacklinkProfile): string[] {
  const lines: string[] = []
  const shares = backlinkProfileShares(p)
  lines.push(`# Backlink profile`)
  lines.push(`Domain: ${p.domain}`)
  lines.push(`Total backlinks: ${p.totalBacklinks.toLocaleString()}`)
  lines.push(`Total referring domains: ${p.totalReferringDomains.toLocaleString()}`)
  lines.push(`Dofollow ratio: ${(p.dofollowRatio * 100).toFixed(1)}%`)
  lines.push(`Anchor diversity (distinct anchors): ${p.anchorDiversity.toLocaleString()}`)
  lines.push(
    `High-quality referring domains (spam<30 AND rank>20): ${p.highQualityDomains}`,
  )
  lines.push(
    `Low-quality referring domains (spam>=50): ${p.lowQualityDomains} (${(shares.lowQualityShare * 100).toFixed(1)}% of referring domains)`,
  )
  lines.push(
    `New links in last 12 months: ${p.newLinksLast12Months}; of those, low-quality: ${p.newLinksLast12MonthsLowQuality} (${(shares.newLinkLowQualityShare * 100).toFixed(1)}%)`,
  )
  lines.push(
    `Backlink Profile section required: ${shares.sectionRequired ? "YES — emit a Backlink Profile section in the Markdown output" : "no — omit the section entirely"}`,
  )
  lines.push(
    `Tier 1 backlink-profile finding required: ${shares.tier1 ? "YES — new-link low-quality share > 40%; surface in Executive Summary AND Key Findings" : "no"}`,
  )
  if (p.sampleLowQualityLinks.length > 0) {
    lines.push("")
    lines.push(`## Sample low-quality referring domains (cite VERBATIM in the report)`)
    for (const d of p.sampleLowQualityLinks) {
      lines.push(
        `  - ${d.domain} — spam ${d.spamScore}, rank ${d.domainRank}, ${d.backlinks} backlinks${d.firstSeen ? `, first seen ${d.firstSeen}` : ""}`,
      )
    }
  }
  lines.push("")
  return lines
}

function buildUrlStructureSection(u: UrlStructureIssues): string[] {
  const lines: string[] = []
  if (u.parallelStructures.length === 0 && u.childCollisions.length === 0) {
    return lines
  }
  lines.push(`# URL structure issues`)
  lines.push(
    `URL Structure section required: YES — parallel-structure conflict(s) detected.`,
  )
  if (u.parallelStructures.length > 0) {
    lines.push("")
    lines.push(`## Parallel structures (semantically equivalent top-level segments coexisting)`)
    for (const ps of u.parallelStructures) {
      const pairLabel = ps.segments.map((s) => `/${s}/`).join(" + ")
      const childCounts = ps.segments
        .map((s) => `${ps.childCountPerSegment[s] ?? 0} under /${s}/`)
        .join(", ")
      lines.push(
        `  - cluster=${ps.cluster}: ${pairLabel} — ${childCounts}`,
      )
      if (ps.sampleOverlappingSlugs.length > 0) {
        lines.push(
          `      overlapping slugs (cite VERBATIM): ${ps.sampleOverlappingSlugs.slice(0, 8).join(", ")}`,
        )
      }
    }
  }
  if (u.childCollisions.length > 0) {
    lines.push("")
    lines.push(
      `## Child URL collisions (same trailing slug under multiple parallel parents — high-confidence duplicates)`,
    )
    for (const c of u.childCollisions.slice(0, 15)) {
      const pct = Math.round(c.similarityScore * 100)
      lines.push(
        `  - slug "${c.slug}" — ${c.paths.length} paths, title+H1 token similarity ${pct}%`,
      )
      for (const p of c.paths) {
        const title = c.titles[p]
        const h1 = c.h1s[p]
        lines.push(
          `      ${truncate(p, 120)}${title ? ` — title="${truncate(title, 70)}"` : " — title=(missing)"}${h1 ? ` h1="${truncate(h1, 70)}"` : ""}`,
        )
      }
    }
  }
  lines.push("")
  return lines
}

function buildBrokenInternalLinksSection(b: BrokenInternalLinks): string[] {
  const lines: string[] = []
  if (b.totalBrokenLinks === 0) return lines
  lines.push(`# Broken internal links`)
  lines.push(
    `Total broken internal-link targets: ${b.totalBrokenLinks} (cross-referenced internalLinksOut against nonOkPages)`,
  )
  const typoCount = b.brokenTargets.filter((t) => t.likelyTypoOf).length
  if (typoCount > 0) {
    lines.push(
      `Likely-typo targets: ${typoCount} (Levenshtein ≤ 2 against an OK sibling). Cite the suggested correction in the recommendation.`,
    )
  }
  lines.push("")
  lines.push(`## Broken targets (sorted by source-page count)`)
  for (const t of b.brokenTargets.slice(0, 25)) {
    const typo = t.likelyTypoOf
      ? ` — likely typo of ${truncate(t.likelyTypoOf, 100)}`
      : ""
    lines.push(
      `  - ${t.statusCode} ${truncate(t.brokenUrl, 110)} (linked from ${t.sourceCount} page${t.sourceCount === 1 ? "" : "s"})${typo}`,
    )
    for (const src of t.sourcePages.slice(0, 3)) {
      lines.push(`      linked from: ${truncate(src, 120)}`)
    }
  }
  lines.push("")
  return lines
}

function buildLocationCompetitorSection(
  rows: LocationCompetitorSnippet[],
): string[] {
  const lines: string[] = []
  if (rows.length === 0) return lines
  lines.push(`# Location competitor snippets`)
  for (const r of rows) {
    lines.push("")
    lines.push(`## ${r.city}, ${r.state}`)
    lines.push(
      `Prospect organic traffic estimate: ${r.prospectOrganicTraffic.toLocaleString()}`,
    )
    for (const c of r.topCompetitors.slice(0, 5)) {
      lines.push(
        `  - ${c.domain} — ${c.organicTraffic.toLocaleString()} traffic, ${c.organicKeywords.toLocaleString()} organic keywords`,
      )
      for (const q of c.sampleQueries.slice(0, 3)) {
        lines.push(
          `      "${truncate(q.query, 70)}" — pos ${q.position}, vol ${q.searchVolume}`,
        )
      }
    }
  }
  lines.push("")
  return lines
}

/**
 * Detect when title/description extraction looks unreliable. A real site
 * essentially never has 90%+ of OK pages missing both <title> and the
 * meta description — that pattern means the crawler couldn't read the
 * head, almost always due to (a) the site's CDN/WAF returning a stripped
 * challenge body to non-browser UAs, or (b) the site rendering its head
 * via JavaScript (which our static cheerio crawler can't see).
 *
 * When this fires, we push a UI warning AND tell Claude not to generate
 * any "missing titles/descriptions" findings — they'd be fabricated,
 * not real.
 */
function detectMetaUnreliable(crawl: CrawlReport): {
  unreliable: boolean
  okPagesCount: number
  missingTitleRate: number
  missingDescriptionRate: number
} {
  const okPagesCount = Math.max(0, crawl.crawledCount - crawl.nonOkPages.length)
  if (okPagesCount <= 5) {
    return {
      unreliable: false,
      okPagesCount,
      missingTitleRate: 0,
      missingDescriptionRate: 0,
    }
  }
  const missingTitleRate = crawl.missingTitles.length / okPagesCount
  const missingDescriptionRate = crawl.missingDescriptions.length / okPagesCount
  const unreliable = missingTitleRate >= 0.9 && missingDescriptionRate >= 0.9
  return { unreliable, okPagesCount, missingTitleRate, missingDescriptionRate }
}

function buildPrompt(params: {
  body: Body
  gsc: AssessmentGscData | null
  ga4: AssessmentGa4Data | null
  crawl: CrawlReport
  cannibalization: CannibalizationCluster[]
  pageSpeed: PageSpeedReport
  backlinkProfile?: BacklinkProfile | null
  urlStructureIssues?: UrlStructureIssues | null
  brokenInternalLinks?: BrokenInternalLinks | null
  locationCompetitorSnippets?: LocationCompetitorSnippet[] | null
  metaUnreliable?: boolean
}): string {
  const {
    body,
    gsc,
    ga4,
    crawl,
    cannibalization,
    pageSpeed,
    backlinkProfile,
    urlStructureIssues,
    brokenInternalLinks,
    locationCompetitorSnippets,
    metaUnreliable,
  } = params
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
  if (metaUnreliable) {
    lines.push(
      `Title and meta-description detection is UNRELIABLE for this audit. The crawler could not read <title> or <meta name="description"> on the overwhelming majority of pages, which is structurally implausible for a real site. Most likely cause: the site's CDN/WAF returned challenge pages instead of real HTML, or the site renders its <head> via JavaScript (which the static crawler cannot see). DO NOT generate any findings about missing titles or missing meta descriptions, and DO NOT cite the missing-title/description counts. Treat that data as not collected.`,
    )
  } else {
    lines.push(`Pages missing titles: ${crawl.missingTitles.length}`)
    for (const u of crawl.missingTitles.slice(0, 5)) {
      lines.push(`  - ${truncate(u, 120)}`)
    }
    lines.push(`Pages missing meta descriptions: ${crawl.missingDescriptions.length}`)
  }
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
  lines.push("")
  // Schema coverage matrix — replaces the legacy binary "present / missing"
  // pair. Per-bucket gap detail with sample URLs so Claude can cite specific
  // pages instead of waving at "schema is missing somewhere on the site".
  const matrix = crawl.schemaCoverageMatrix
  lines.push(`## Schema coverage matrix`)
  lines.push(
    `Distinct @types in use sitewide: ${matrix.schemaTypesInUse.join(", ") || "none"}`,
  )
  for (const b of matrix.buckets) {
    lines.push("")
    lines.push(`### ${b.pageType} pages — ${b.pageCount} crawled`)
    if (b.pageCount === 0) {
      lines.push(`  (no pages classified into this bucket)`)
      continue
    }
    lines.push(`  Expected: ${b.typesExpected.join(", ")}`)
    lines.push(
      `  Found:    ${b.typesFound.length > 0 ? b.typesFound.join(", ") : "none"}`,
    )
    lines.push(
      `  Missing:  ${b.typesMissing.length > 0 ? b.typesMissing.join(", ") : "none"}`,
    )
    lines.push(
      `  Pages with ZERO JSON-LD: ${b.pagesWithNoSchema}/${b.pageCount}`,
    )
    if (b.sampleUrls.length > 0) {
      lines.push(`  Sample URLs:`)
      for (const u of b.sampleUrls) lines.push(`    - ${truncate(u, 120)}`)
    }
  }
  if (matrix.prioritizedRecommendations.length > 0) {
    lines.push("")
    lines.push(`### Prioritized schema additions (lower number = higher impact)`)
    for (const r of matrix.prioritizedRecommendations) {
      lines.push(
        `  P${r.priority}. Add ${r.missingType} to ${r.pageType} pages (${r.pageCount} pages affected)`,
      )
    }
  }
  lines.push("")
  lines.push(`Image alt coverage: ${crawl.imageAltCoveragePercent}%`)
  lines.push("")

  // PageSpeed Insights — emitted before cannibalization so performance
  // findings can compete for the top of the Key Findings list. The block
  // self-reports whether the Performance section + Tier 1 rule should fire.
  for (const line of buildPageSpeedSection(pageSpeed)) {
    lines.push(line)
  }

  // Cannibalization clusters — pre-computed by lib/cannibalization.ts so
  // Claude doesn't have to re-derive them from the title list. Only emit the
  // section when there's at least one cluster; absence is meaningful too,
  // but mentioning "no clusters" in the prompt invites Claude to fabricate.
  if (cannibalization.length > 0) {
    const tier1Cannibalization = cannibalization.length > 5
    lines.push(`# Keyword cannibalization clusters`)
    lines.push(
      `${cannibalization.length} cluster(s) of pages competing for the same keyword/location combination.`,
    )
    lines.push(
      `Tier 1 cannibalization finding required: ${tier1Cannibalization ? "YES — > 5 clusters; surface in Executive Summary AND Key Findings" : "no"}`,
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

  // Backlink profile — Tier 1 trigger fires when new-link low-quality share
  // crosses 40%. Section is omitted entirely when the data does not warrant
  // concern (sectionRequired=false).
  if (backlinkProfile) {
    for (const line of buildBacklinkProfileSection(backlinkProfile)) {
      lines.push(line)
    }
  }

  // URL structure issues — Tier 2. Always omitted when no conflicts exist.
  if (urlStructureIssues) {
    for (const line of buildUrlStructureSection(urlStructureIssues)) {
      lines.push(line)
    }
  }

  // Broken internal links — Tier 2. Omitted when totalBrokenLinks is 0.
  if (brokenInternalLinks) {
    for (const line of buildBrokenInternalLinksSection(brokenInternalLinks)) {
      lines.push(line)
    }
  }

  // Per-location competitor snippets — feeds the "Competitive Position by
  // Location" section. Omitted when the list is empty.
  if (locationCompetitorSnippets && locationCompetitorSnippets.length > 0) {
    for (const line of buildLocationCompetitorSection(
      locationCompetitorSnippets,
    )) {
      lines.push(line)
    }
  }

  return lines.join("\n")
}

const SYSTEM_PROMPT = `You are a senior SEO analyst producing an SEO audit for a prospective Harbinger Marketing partner. Output is read in-app and exported to markdown — render the audit as well-structured Markdown.

PRIORITIZATION TIERS (apply silently — surface findings, not the rules):

Tier 1 — material; executive-summary headline candidates. ANY of these triggers Tier 1:
  - probably_not_indexed > 20 sitemap URLs OR > 10% of sitemap
  - cannibalization clusters > 5
  - homepage mobile performance score < 50
  - new-link low-quality share > 40% (low-quality = spam_score >= 50)
The data blocks self-report when each Tier 1 trigger fires ("Tier 1 ... finding required: YES"); honor those flags. Multiple Tier 1 findings can fire at once. Every Tier 1 finding MUST appear as a bullet in the Executive Summary AND as a numbered Key Finding with a bolded headline metric.

Tier 2 — important but not headline-grade:
  - missing required schema on >= 1 bucket with at least one crawled page (the "Schema coverage matrix")
  - missing titles or meta descriptions at scale (>= 5 pages)
  - URL structure conflicts (mixed protocol, mixed www/apex, mixed trailing slash, deep nesting) when the "URL structure issues" block is present
  - broken internal links when the "Broken internal links" block reports any

Tier 3 — optimization opportunities:
  - quick-win CTR uplift (positions 4-10) calibrated to the prospect's own data
  - content gaps for priority services / target locations
  - schema enrichment beyond required types

OUTPUT RULES:
1. The Executive Summary leads with the most material Tier 1 finding. If no Tier 1 fires, lead with the most material Tier 2 finding. Quantify in business language wherever possible — "lifting CTR from X% to Y% on N queries adds ~Z clicks/year" beats "the title tags are weak."
2. Do NOT make claims that aren't grounded in the data inputs. If a section's trigger is not met, OMIT that section entirely rather than padding with non-issues.
3. Every finding cites a specific URL, count, percentage, or query taken VERBATIM from the data. Generic findings are forbidden.
4. When GSC or GA4 is absent, acknowledge the gap honestly in the Executive Summary rather than fabricating numbers.
5. Do NOT cite industry CTR averages — use the prospect's own GSC data only.
6. Findings related to priority services and target locations get surfaced first within each tier.
7. Where GSC shows the site already ranking for priority-service keywords, lead with optimization recommendations rather than new-page recommendations.

OUTPUT FORMAT (Markdown — emit sections in EXACTLY this order; OMIT a section entirely when its trigger is not met):

# SEO Audit — <prospect domain>

## Executive Summary
5-7 bullets. Bullet #1 is the single most material Tier 1 finding (or the top Tier 2 if no Tier 1 fires). Each bullet is one sentence with a quantified headline metric. If GSC or GA4 is absent, one bullet names that gap explicitly.

## Key Findings
Numbered findings (typically 5-9 total). Each has a one-line **bold headline metric**. Tier 1 findings come first, then Tier 2, then Tier 3 — preserve that ordering. Each finding cites a specific URL, count, percentage, or query verbatim.

## YoY Traffic Chart
Include this section ONLY when GA4 is connected. Output one short sentence reading the YoY trend (e.g. "Organic sessions are down 18% YoY, driven by losses on /services/water-heaters and /locations/charlotte"). Leave a blank line after the sentence — the YoY chart SVG is injected at this position by the renderer.

## Traffic & Visibility
Read of GSC + GA4 data. Highlight priority-service queries already ranking (lead with these), and target locations with no visibility (flag these). If GA4 conversions are configured, translate traffic gaps to leads/revenue in plain language. Skip this section when both GSC and GA4 are absent.

## Indexation Status
Include ONLY when the "Indexation coverage" block is present. When the block reports "Tier 1 indexation-gap finding required: YES", lead with the bolded metric "**X of Y sitemap URLs (Z%) have not received a single impression in 90 days**". Quote 2-3 representative not-indexed URLs verbatim. Reference URL Inspection results when present (e.g. "Search Console confirms coverage state 'Crawled - currently not indexed'").

## Cannibalization
Include ONLY when the "Keyword cannibalization clusters" block is present. One subsection per cluster:
- List competing URLs verbatim.
- Name the shared signal (identical title, title similarity, URL pattern, or SERP overlap); quote the shared query/title when present.
- Recommend the winning URL based on the strongest signal — prefer more GSC clicks, otherwise better rank, otherwise longer / more linked URL. Be explicit: "Keep <URL>; 301 redirect <URL>".
- For "differentiate_intent" hints, recommend rewriting titles/intent rather than redirecting; for "consolidate_to_stronger", recommend the 301.

## Performance / Core Web Vitals
Include ONLY when the PageSpeed Insights block reports "Performance section required: YES". Lead with the average mobile score, then the homepage score on its own line. Cite specific failing pages with exact LCP (s) / CLS / INP (ms) values verbatim. Recommend 1-2 of the named opportunities verbatim (e.g. "Eliminate render-blocking resources"). No generic Core Web Vitals advice.

## Backlink Profile
Include ONLY when the "Backlink profile" block reports "Backlink Profile section required: YES". Cite the low-quality share, the new-link low-quality share when relevant, and 2-3 of the sampleLowQualityLinks domains by name verbatim. When Tier 1 fires (new-link low-quality share > 40%), lead with that.

## Technical Findings
Specific crawl-level issues ordered by impact. Cite exact pages.

## URL Structure Issues
Include ONLY when the "URL structure issues" block is present. Group by issue type (mixed protocol, mixed www/apex, mixed trailing slash, deep nesting). For each, state the canonical form and cite 2-3 offending URLs verbatim. Recommend a single canonical and the redirect rule that resolves the conflict.

## Schema Coverage
Render the "Schema coverage matrix" as a Markdown table with columns: Page Type | Pages Crawled | Expected | Found | Missing. After the table, list 1-3 prioritized recommendations in the order from the "Prioritized schema additions" block (P1 first), each citing exact bucket counts and at least one sample URL per gap. When every bucket is fully covered, say so in one sentence and skip the recommendations. Do NOT recommend types the matrix already shows as present. When a bucket has any missing required type AND at least one page exists, that gap MUST also appear as a numbered Key Finding with a bolded headline metric of the form "**X of Y <bucket> pages missing <type>**".

## Target Location Coverage
One short row per target location: does the site have a corresponding page? Is it ranking? Use the data provided.

## Competitive Position by Location
Include ONLY when the "Location competitor snippets" block is present. One subsection per target market. Name the top 3 competitors by organic-traffic estimate, the prospect's gap vs. each, and 1-2 high-value queries the prospect is missing (cite query + position + search volume verbatim).

## 90-Day Roadmap
Auto-prioritized by tier — do NOT group by service category:
- Month 1 — every Tier 1 fix (one bullet per Tier 1 finding). If fewer than 3 Tier 1 findings exist, fill remaining Month 1 slots with the highest-impact Tier 2 fixes.
- Month 2 — Tier 2 fixes (schema gaps, scaled missing-meta cleanup, URL-structure canonicalization, broken-link repair).
- Month 3 — Tier 3 fixes (CTR optimization, content gaps, schema enrichment).
Each bullet references the relevant findings by number ("Resolves Finding #3"). 2-3 actions per month.

## Appendix: Other Issues
One-liners for issues that didn't make the top findings. Optional.

CONSTRAINTS:
- Length: 800-1500 words of finished prose.
- No partner profile boilerplate.
- Every recommendation specifies the exact pages, queries, and metrics being addressed.`

/**
 * Insert the YoY organic-sessions chart (full chart inside the new
 * "## YoY Traffic Chart" section; sparkline at the end of the
 * "## Executive Summary" block) into the markdown Claude produced.
 *
 * Silently no-ops when GA4 is absent or returned no monthly rows. Each
 * insertion is idempotent on the heading regex — we never insert twice.
 */
function injectOrganicSessionsChart(
  markdown: string,
  ga4: AssessmentGa4Data | null,
): string {
  if (!ga4 || ga4.monthlyOrganic.length === 0) return markdown
  const data = buildOrganicSeries(ga4.monthlyOrganic)
  if (!data) return markdown

  const chartBlock = renderOrganicSessionsBlock(data)
  const sparkline = renderOrganicSessionsSparklineSvg(data)

  let out = markdown

  // Inject the full chart immediately after the "## YoY Traffic Chart"
  // heading. The system prompt instructs Claude to emit a one-sentence read
  // of the YoY trend under that heading and leave the chart placeholder for
  // us to fill.
  const yoyHeading = /^(##\s+YoY\s+Traffic\s+Chart[^\n]*)\n/m
  const trafficHeading = /^(##\s+Traffic\s*&(?:amp;)?\s*Visibility[^\n]*)\n/m
  if (yoyHeading.test(out)) {
    out = out.replace(yoyHeading, `$1\n\n${chartBlock}\n`)
  } else if (trafficHeading.test(out)) {
    // Fallback: older outputs (or drift) place the chart with the
    // Traffic & Visibility section. Insert there so we never silently lose
    // the chart from the rendered audit.
    out = out.replace(trafficHeading, `$1\n\n${chartBlock}\n`)
  } else {
    out = `${out.trimEnd()}\n\n## YoY Traffic Chart\n\n${chartBlock}\n`
  }

  // Inject the sparkline at the END of the "## Executive Summary" block,
  // before the next "## " heading. Single-line trailing aside so it doesn't
  // shove the lead sentence around.
  const execMatch = out.match(/^##\s+Executive Summary[^\n]*\n/m)
  if (execMatch && sparkline) {
    const startIdx = (execMatch.index ?? 0) + execMatch[0].length
    const rest = out.slice(startIdx)
    const nextHeadingIdx = rest.search(/\n##\s+/)
    const insertAt =
      nextHeadingIdx === -1 ? out.length : startIdx + nextHeadingIdx
    const aside = `\n\n*12-month organic trend:* ${sparkline}\n`
    out = `${out.slice(0, insertAt)}${aside}${out.slice(insertAt)}`
  }

  return out
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
  const body: Body = parsed.data

  const startedAt = Date.now()
  const warnings: string[] = []
  const websiteUrl = cleanWebsite(body.websiteUrl)

  let gsc: AssessmentGscData | null = null
  let gscQueryPages: GSCQueryRow[] = []
  let ga4: AssessmentGa4Data | null = null
  let crawl: CrawlReport
  let backlinkProfileData: BacklinkProfile | null = null
  try {
    const [gscRes, ga4Res, crawlRes, backlinkProfileRes] = await Promise.all([
      tryFetchGsc(websiteUrl, warnings),
      tryFetchGa4(websiteUrl, warnings),
      crawlSite({
        domain: websiteUrl,
        options: { mode: body.crawlMode },
      }),
      // Non-fatal: surface as a warning if it fails but keep the audit going.
      // The synthesis prompt's Backlink Profile section is gated on the
      // returned shares, so a null here just suppresses the section.
      backlinkProfile(websiteUrl).catch((err) => {
        const msg = err instanceof Error ? err.message : "Unknown error"
        warnings.push(`Backlink profile fetch failed; the audit will continue without it. (${msg})`)
        return null
      }),
    ])
    gsc = gscRes?.data ?? null
    gscQueryPages = gscRes?.queryPages ?? []
    ga4 = ga4Res
    crawl = crawlRes
    backlinkProfileData = backlinkProfileRes
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

  // URL structure + broken-internal-link analyses are pure functions over
  // the existing crawl output — no extra network calls.
  const urlStructureIssues = detectUrlStructureIssues(crawl)
  const brokenInternalLinks = detectBrokenInternalLinks(crawl)
  console.log(
    `[audit:url-structure] domain=${websiteUrl} parallel=${urlStructureIssues.parallelStructures.length} collisions=${urlStructureIssues.childCollisions.length}`,
  )
  console.log(
    `[audit:broken-links] domain=${websiteUrl} broken_targets=${brokenInternalLinks.totalBrokenLinks} typos=${brokenInternalLinks.brokenTargets.filter((t) => t.likelyTypoOf).length}`,
  )

  // PageSpeed runs after GSC because the URL set is "top GSC pages by
  // impressions + homepage". When GSC didn't connect we still audit the
  // homepage. Failures are non-fatal — `runPageSpeedAudit` returns a
  // skipped report rather than throwing.
  const topGscPages = gsc
    ? [...gsc.topPages]
        .sort((a, b) => b.impressions - a.impressions)
        .map((p) => p.page)
    : []
  const pageSpeed = await runPageSpeedAudit({
    domain: websiteUrl,
    topGscPages,
  })
  if (pageSpeed.skippedReason) {
    warnings.push(pageSpeed.skippedReason)
  }

  // Sanity check: if the crawler reports ~100% of pages missing both
  // <title> and meta description, that's almost certainly a crawler-side
  // problem (WAF challenge pages or JS-rendered head), not a real SEO
  // issue. Warn the user and tell the synthesis to skip the finding.
  const metaCheck = detectMetaUnreliable(crawl)
  if (metaCheck.unreliable) {
    const titlePct = Math.round(metaCheck.missingTitleRate * 100)
    const descPct = Math.round(metaCheck.missingDescriptionRate * 100)
    warnings.push(
      `Title/description detection looks unreliable: ${titlePct}% of crawled pages were missing <title> and ${descPct}% were missing meta descriptions. That pattern is implausible for a real site and usually means the site's CDN/WAF served stripped responses to the crawler, or the site renders its <head> via JavaScript. The audit will skip the missing-titles/descriptions finding — open the homepage in your browser, view source, and confirm whether the tags are present in the static HTML.`,
    )
    console.log(
      `[audit:meta-check] domain=${websiteUrl} ok_pages=${metaCheck.okPagesCount} missing_titles=${titlePct}% missing_descriptions=${descPct}% → suppressing finding`,
    )
  }

  let auditMarkdown: string
  try {
    const prompt = buildPrompt({
      body,
      gsc,
      ga4,
      crawl,
      cannibalization,
      pageSpeed,
      backlinkProfile: backlinkProfileData,
      urlStructureIssues,
      brokenInternalLinks,
      metaUnreliable: metaCheck.unreliable,
    })
    auditMarkdown = await callClaude(prompt, {
      model: "claude-opus-4-7",
      system: SYSTEM_PROMPT,
      maxTokens: 12_000,
    })
    auditMarkdown = injectOrganicSessionsChart(auditMarkdown, ga4)
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
