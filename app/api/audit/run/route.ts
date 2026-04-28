import { NextResponse } from "next/server"
import { z } from "zod"
import { detectBrokenInternalLinks } from "@/lib/audit-broken-links"
import { detectUrlStructureIssues } from "@/lib/audit-url-structure"
import { detectCannibalization } from "@/lib/cannibalization"
import { crawlSite } from "@/lib/audit-crawl"
import { detectMetaUnreliable } from "@/lib/audit-synthesis"
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
  AssessmentGa4Data,
  AssessmentGscData,
  AuditCrawlSummary,
  AuditDataBundle,
  BacklinkProfile,
  CrawlReport,
  GSCQueryRow,
} from "@/lib/types"

/**
 * Assessment Audit gather endpoint.
 *
 * Returns an `AuditDataBundle` (crawl + GSC + GA4 + analyses + warnings).
 * The client posts the bundle to `/api/audit/synthesize` to get the Opus
 * markdown back. Splitting the pipeline this way keeps each request
 * inside Vercel's 800s function budget.
 *
 * Stateless. Always pre-sales mode (manual inputs only — no Airtable
 * lookup). Uses the assessments Google account exclusively.
 *
 * Sequence:
 *   1. Validate inputs (websiteUrl + at least one targetMarket required)
 *   2. Fetch GSC + GA4 (assessments token), tolerating both being absent
 *   3. Crawl the site
 *   4. Synthesize markdown via Claude (claude-opus-4-7)
 *   5. Return AuditDataBundle (the synthesize route handles step 5).
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

  const gatherDurationSeconds = Math.round((Date.now() - startedAt) / 1000)
  console.log(
    `[audit:gather-done] domain=${websiteUrl} duration=${gatherDurationSeconds}s pages=${crawl.crawledCount} warnings=${warnings.length}`,
  )

  const bundle: AuditDataBundle = {
    websiteUrl,
    generatedAt: new Date().toISOString(),
    gatherDurationSeconds,
    warnings,
    body: {
      websiteUrl: body.websiteUrl,
      partnerName: body.partnerName,
      priorityServices: body.priorityServices,
      negativeKeywords: body.negativeKeywords,
      existingTargetKeywords: body.existingTargetKeywords,
      idealCustomer: body.idealCustomer,
      targetMarkets: body.targetMarkets,
    },
    gsc,
    ga4,
    crawl,
    pageSpeed,
    cannibalization,
    backlinkProfile: backlinkProfileData,
    urlStructureIssues,
    brokenInternalLinks,
    metaUnreliable: metaCheck.unreliable,
    crawlSummary: summarizeCrawl(crawl),
  }
  return NextResponse.json(bundle)
}
