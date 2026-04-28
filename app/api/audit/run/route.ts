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
import { emailFor, type GoogleAccount } from "@/lib/google-auth"
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
  PageSpeedReport,
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
 * lookup). GSC/GA4 lookups run on both Google accounts (`assessments`
 * and `partners`) in parallel; whichever account verifies the prospect's
 * domain wins. Catches the case where a prospect site was granted to the
 * partners account by mistake.
 *
 * Sequence:
 *   1. Validate inputs (websiteUrl + at least one targetMarket required)
 *   2. Fetch GSC + GA4 (try both tokens, prefer assessments on tie),
 *      tolerating both being absent
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
  /**
   * "City, ST" preferred; objects work too if the client already split them.
   * Optional — when omitted/empty the audit skips location-specific coverage
   * findings (Target Location Coverage section + city-token cannibalization
   * grouping).
   */
  targetMarkets: z.array(targetMarketSchema).max(10).optional().default([]),
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
  /** Account whose refresh token resolved this site. Threaded into the
   * follow-up index-coverage fetch so it talks to the same GSC identity. */
  account: GoogleAccount
  /** Long-range [query, page] export used by the cannibalization detector. */
  queryPages: GSCQueryRow[]
}

/**
 * Resolve the prospect's GSC site URL across both Google accounts. We list
 * sites on `assessments` and `partners` in parallel and pick the first
 * account that returns a hostname match. Most prospect sites are shared
 * with the assessments account, but a handful end up granted to the
 * partners account by mistake — supporting both prevents a silent
 * "GSC not connected" downgrade in that case.
 *
 * Priority is `assessments` → `partners` when both match; we surface a
 * warning so the user knows which token won.
 */
async function resolveGscAccountAndSite(
  websiteUrl: string,
  warnings: string[],
): Promise<{ account: GoogleAccount; siteUrl: string } | null> {
  const accounts: GoogleAccount[] = ["assessments", "partners"]
  const results = await Promise.all(
    accounts.map(async (account) => {
      try {
        const sites = await listSites(account)
        return { account, sites, error: null as unknown }
      } catch (err) {
        return { account, sites: null, error: err }
      }
    }),
  )

  const matched: { account: GoogleAccount; siteUrl: string }[] = []
  for (const r of results) {
    if (!r.sites) continue
    const candidates = findGscSiteCandidates(websiteUrl, r.sites)
    if (candidates.length > 0) {
      matched.push({ account: r.account, siteUrl: candidates[0].siteUrl })
    }
  }

  if (matched.length > 1) {
    warnings.push(
      `GSC: site verified on multiple Google accounts (${matched.map((m) => emailFor(m.account)).join(", ")}). Using ${emailFor(matched[0].account)}.`,
    )
  }
  if (matched.length > 0) {
    return matched[0]
  }

  // No hostname match anywhere. If at least one listSites succeeded, fall
  // back to the URL-prefix guess on assessments — preserves the legacy
  // behavior where unverified-but-typed-in URLs sometimes work. Subsequent
  // fetches will fail loudly if the property isn't actually verified.
  const okResults = results.filter((r) => r.sites !== null)
  if (okResults.length > 0) {
    const fallback =
      okResults.find((r) => r.account === "assessments") ?? okResults[0]
    return {
      account: fallback.account,
      siteUrl: partnerWebsiteToGscSiteUrl(websiteUrl),
    }
  }

  // Both accounts errored. Distinguish missing-token from API failures so
  // the warning is actionable.
  const allMissingToken = results.every(
    (r) => r.error instanceof GSCError && r.error.code === "NO_REFRESH_TOKEN",
  )
  if (allMissingToken) {
    warnings.push(
      `GSC: no refresh token configured for either Google account (${emailFor("assessments")}, ${emailFor("partners")}). The audit will continue using crawl data only.`,
    )
  } else {
    warnings.push(
      `GSC: failed to list sites for both Google accounts (${emailFor("assessments")}, ${emailFor("partners")}). The audit will continue without GSC.`,
    )
  }
  return null
}

async function tryFetchGsc(
  websiteUrl: string,
  warnings: string[],
): Promise<GscFetchResult | null> {
  const resolved = await resolveGscAccountAndSite(websiteUrl, warnings)
  if (!resolved) return null
  const { account, siteUrl } = resolved

  const startDate = isoMonthsAgo(16)
  const endDate = isoDaysAgo(2)
  try {
    const [topQueries, topPages, dailyClicks, queryPages] = await Promise.all([
      getTopQueriesPaginated({
        account,
        siteUrl,
        startDate,
        endDate,
        maxRows: 100,
      }),
      getTopPagesPaginated({
        account,
        siteUrl,
        startDate,
        endDate,
        maxRows: 50,
      }),
      getDailyClicks({
        account,
        siteUrl,
        startDate,
        endDate,
      }),
      // [query, page] export — feeds the SERP-overlap signal in the
      // cannibalization detector. Capped at one API call (5k rows) since
      // ranking pages with positions in the top 20 don't need a deep tail.
      getQueries({
        account,
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
      account,
      queryPages,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown GSC error"
    warnings.push(
      `GSC access not yet granted for this property. Please ensure ${emailFor(account)} has been added as a user on Search Console. The audit will continue using crawl data only. (${msg})`,
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
  account: GoogleAccount,
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
      account,
      siteUrl: gsc.siteUrl,
      startDate,
      endDate,
      rowLimit: 25_000,
    })
    const coverage = await getIndexCoverage({
      account,
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

/**
 * Resolve the prospect's GA4 property across both Google accounts. Same
 * dual-account strategy as `resolveGscAccountAndSite`: list properties on
 * `assessments` and `partners` in parallel, take the first hostname match.
 */
async function resolveGa4AccountAndProperty(
  websiteUrl: string,
  warnings: string[],
): Promise<{ account: GoogleAccount; propertyId: string } | null> {
  const accounts: GoogleAccount[] = ["assessments", "partners"]
  const results = await Promise.all(
    accounts.map(async (account) => {
      try {
        const properties = await listProperties({ account })
        return { account, properties, error: null as unknown }
      } catch (err) {
        return { account, properties: null, error: err }
      }
    }),
  )

  const matched: { account: GoogleAccount; propertyId: string }[] = []
  for (const r of results) {
    if (!r.properties) continue
    const candidates = findGa4PropertyCandidates(websiteUrl, r.properties)
    if (candidates.length > 0) {
      matched.push({ account: r.account, propertyId: candidates[0].propertyId })
    }
  }

  if (matched.length > 1) {
    warnings.push(
      `GA4: property visible on multiple Google accounts (${matched.map((m) => emailFor(m.account)).join(", ")}). Using ${emailFor(matched[0].account)}.`,
    )
  }
  if (matched.length > 0) {
    return matched[0]
  }

  // No match. If at least one listProperties call worked, the access just
  // hasn't been granted on a property either account can see.
  const okResults = results.filter((r) => r.properties !== null)
  if (okResults.length > 0) {
    warnings.push(
      `GA4 access not yet granted for this property. Please ensure ${emailFor("assessments")} or ${emailFor("partners")} has been added as a Viewer on the GA4 property. The audit will continue using GSC + crawl data only.`,
    )
    return null
  }

  // Both accounts errored.
  const allMissingToken = results.every(
    (r) => r.error instanceof GA4Error && r.error.code === "NO_REFRESH_TOKEN",
  )
  if (allMissingToken) {
    warnings.push(
      `GA4: no refresh token configured for either Google account. The audit will continue without GA4.`,
    )
  } else {
    warnings.push(
      `GA4: failed to list properties for both Google accounts (${emailFor("assessments")}, ${emailFor("partners")}). The audit will continue without GA4.`,
    )
  }
  return null
}

async function tryFetchGa4(
  websiteUrl: string,
  warnings: string[],
): Promise<AssessmentGa4Data | null> {
  const resolved = await resolveGa4AccountAndProperty(websiteUrl, warnings)
  if (!resolved) return null
  const { account, propertyId } = resolved

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
      getSeoReport({ account, propertyId, startDate, endDate }),
      getMonthlyOrganic({
        account,
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


/**
 * NDJSON event types streamed back to the client. The client ignores
 * `ping` events (they exist only to keep the connection alive) and
 * uses `stage` events to drive the progress label. Exactly one
 * terminal event — `result` (success) or `error` (failure) — closes
 * the stream.
 */
type StreamEvent =
  | { type: "ping"; t: number }
  | { type: "stage"; stage: string; tElapsedMs: number; detail?: string }
  | { type: "warning"; message: string }
  | { type: "result"; bundle: AuditDataBundle }
  | { type: "error"; error: string }

async function gatherAuditData(
  body: Body,
  send: (event: StreamEvent) => void,
): Promise<AuditDataBundle> {
  const startedAt = Date.now()
  const elapsed = () => Date.now() - startedAt
  const stage = (s: string, detail?: string) =>
    send({ type: "stage", stage: s, tElapsedMs: elapsed(), detail })
  const pushWarning = (warnings: string[], message: string) => {
    warnings.push(message)
    send({ type: "warning", message })
  }

  const warnings: string[] = []
  const websiteUrl = cleanWebsite(body.websiteUrl)
  stage("starting", `domain=${websiteUrl}`)

  let gsc: AssessmentGscData | null = null
  let gscQueryPages: GSCQueryRow[] = []
  let ga4: AssessmentGa4Data | null = null
  let crawl: CrawlReport
  let backlinkProfileData: BacklinkProfile | null = null
  let pageSpeed: PageSpeedReport

  // Kick off the four parallel data fetches. PageSpeed depends on the GSC
  // result (top pages) but NOT on the crawl, so we start it as soon as
  // GSC resolves and let it overlap with the rest of the still-running
  // crawl. This saves ~60-90s on the critical path.
  const gscPromise = tryFetchGsc(websiteUrl, warnings)
  const ga4Promise = tryFetchGa4(websiteUrl, warnings)
  const crawlPromise = crawlSite({
    domain: websiteUrl,
    options: { mode: body.crawlMode },
    onProgress: (p) =>
      stage(
        "crawl_progress",
        `pages=${p.pagesCrawled} queue=${p.pagesInQueue} status=${p.status}`,
      ),
  })
  const backlinkPromise = backlinkProfile(websiteUrl).catch((err) => {
    const msg = err instanceof Error ? err.message : "Unknown error"
    pushWarning(
      warnings,
      `Backlink profile fetch failed; the audit will continue without it. (${msg})`,
    )
    return null
  })
  const pageSpeedPromise = (async () => {
    const gscRes = await gscPromise
    stage("gsc_ready")
    const topGscPages = gscRes?.data
      ? [...gscRes.data.topPages]
          .sort((a, b) => b.impressions - a.impressions)
          .map((p) => p.page)
      : []
    const ps = await runPageSpeedAudit({
      domain: websiteUrl,
      topGscPages,
    })
    if (ps.skippedReason) pushWarning(warnings, ps.skippedReason)
    stage("pagespeed_done", `urls=${ps.pages.length}`)
    return ps
  })()

  // Surface "crawl_done" as soon as the crawl resolves so the client
  // sees the bottleneck stage flip. The other three (gsc/ga4/backlinks)
  // are normally faster and finish silently.
  crawlPromise
    .then((c) =>
      stage(
        "crawl_done",
        `pages=${c.crawledCount} sitemap=${c.sitemapUrls.length}`,
      ),
    )
    .catch(() => {
      /* error surfaced by Promise.all below */
    })

  const [gscRes, ga4Res, crawlRes, backlinkProfileRes, pageSpeedRes] =
    await Promise.all([
      gscPromise,
      ga4Promise,
      crawlPromise,
      backlinkPromise,
      pageSpeedPromise,
    ])
  gsc = gscRes?.data ?? null
  gscQueryPages = gscRes?.queryPages ?? []
  ga4 = ga4Res
  crawl = crawlRes
  backlinkProfileData = backlinkProfileRes
  pageSpeed = pageSpeedRes
  stage("parallel_done", `pages=${crawl.crawledCount} ga4=${ga4 ? "yes" : "no"} gsc=${gsc ? "yes" : "no"}`)

  if (gsc && gscRes) {
    stage("index_coverage_started")
    await tryFetchIndexCoverage(
      gscRes.account,
      gsc,
      crawl.sitemapUrls,
      warnings,
    )
    stage("index_coverage_done")
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

  const urlStructureIssues = detectUrlStructureIssues(crawl)
  const brokenInternalLinks = detectBrokenInternalLinks(crawl)
  console.log(
    `[audit:url-structure] domain=${websiteUrl} parallel=${urlStructureIssues.parallelStructures.length} collisions=${urlStructureIssues.childCollisions.length}`,
  )
  console.log(
    `[audit:broken-links] domain=${websiteUrl} broken_targets=${brokenInternalLinks.totalBrokenLinks} typos=${brokenInternalLinks.brokenTargets.filter((t) => t.likelyTypoOf).length}`,
  )

  const metaCheck = detectMetaUnreliable(crawl)
  if (metaCheck.unreliable) {
    const titlePct = Math.round(metaCheck.missingTitleRate * 100)
    const descPct = Math.round(metaCheck.missingDescriptionRate * 100)
    pushWarning(
      warnings,
      `Title/description detection looks unreliable: ${titlePct}% of crawled pages were missing <title> and ${descPct}% were missing meta descriptions. That pattern is implausible for a real site and usually means the site's CDN/WAF served stripped responses to the crawler, or the site renders its <head> via JavaScript. The audit will skip the missing-titles/descriptions finding — open the homepage in your browser, view source, and confirm whether the tags are present in the static HTML.`,
    )
    console.log(
      `[audit:meta-check] domain=${websiteUrl} ok_pages=${metaCheck.okPagesCount} missing_titles=${titlePct}% missing_descriptions=${descPct}% → suppressing finding`,
    )
  }

  const gatherDurationSeconds = Math.round(elapsed() / 1000)
  console.log(
    `[audit:gather-done] domain=${websiteUrl} duration=${gatherDurationSeconds}s pages=${crawl.crawledCount} warnings=${warnings.length}`,
  )

  return {
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

  // Stream NDJSON. The client reads the stream and looks for the
  // terminal `result` (success) or `error` (failure) event. `ping`
  // events keep browser/edge connections alive across the multi-minute
  // gather phase — without them, idle-connection timeouts in browsers
  // and intermediate proxies surface as "Failed to fetch" on the
  // client even when the function is still running cleanly.
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder()
      let closed = false
      const send = (event: StreamEvent) => {
        if (closed) return
        try {
          controller.enqueue(enc.encode(JSON.stringify(event) + "\n"))
        } catch {
          /* controller already closed; nothing to do */
        }
      }

      const pinger = setInterval(() => {
        send({ type: "ping", t: Date.now() })
      }, 10_000)

      try {
        const bundle = await gatherAuditData(body, send)
        send({ type: "result", bundle })
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error"
        console.error("[audit:gather-failed]", msg)
        send({ type: "error", error: `Audit data fetch failed: ${msg}` })
      } finally {
        clearInterval(pinger)
        closed = true
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache, no-transform",
      // Disable buffering at any intermediate proxy so the heartbeats
      // actually reach the client at the cadence we send them.
      "X-Accel-Buffering": "no",
    },
  })
}
