import "server-only"
import {
  createCostAccumulator,
  totalCostUsd,
  withAuditCost,
} from "@/lib/audit-cost"
import { crawlSite, CrawlError } from "@/lib/audit-crawl"
import { runPageSpeedAudit } from "@/lib/pagespeed"
import type { CrawledPage, CrawlResults, SchemaCoverageMatrix } from "@/lib/types"

/**
 * Engine for the Technical Crawls tab. Wraps the existing audit crawl +
 * PageSpeed pieces into a single deterministic pipeline that returns a
 * compact persisted shape suitable for Supabase + a dashboard diff view.
 *
 * Boundaries:
 *   - Pure compute. Caller is responsible for writing to Supabase, looking
 *     up partner records, etc. The engine doesn't know about partner_id —
 *     it just takes a domain + label.
 *   - Sample-based. Crawl runs at ~50-page ceiling (DataForSEO On-Page
 *     "sample" mode); we persist a 16-URL sample slice and a sitewide
 *     summary. Drill-down beyond the sample requires re-crawling.
 *   - Mobile Lighthouse only. Google ranks on mobile and the desktop pass
 *     was never read by any consumer.
 *   - All costs flow through the audit-cost AsyncLocalStorage helper, so
 *     `costUsd` reflects DataForSEO + Claude even though Claude isn't
 *     called here directly (left in as a hedge for future synthesis steps).
 */

const SAMPLE_PAGES_CAP = 16
const PAGESPEED_URL_CAP = 5

// ── Persisted shapes (mirrored in lib/supabase.ts JSON columns) ────────────

export interface TechnicalCrawlSummary {
  totalPages: number
  okPages: number
  nonOkPages: number
  /** title / description / canonical issue counts at site level. */
  missingTitles: number
  missingDescriptions: number
  missingCanonicals: number
  duplicateTitleGroups: number
  duplicateDescriptionGroups: number
  thinContentPages: number
  spaShellPages: number
  imageAltCoveragePercent: number
  /** sitemapUrls.length at discovery time. */
  sitemapSize: number
  /** robots.txt crawl-delay applied. */
  crawlDelaySec: number
  /** keys are status codes ("200", "404", ...) → counts. */
  statusCodeDistribution: Record<string, number>
}

export interface TechnicalCrawlLighthouse {
  averageMobileScore: number | null
  homepageMobileScore: number | null
  /** One entry per audited URL. */
  pages: Array<{
    url: string
    performanceScore: number | null
    lcpMs: number | null
    inpMs: number | null
    cls: number | null
    ttfbMs: number | null
  }>
  /** PSI failures for individual URLs (PSI down, page errored, etc.). */
  failures: Array<{ url: string; reason: string }>
  /** Set when the whole pass was skipped (no PAGESPEED_API_KEY). */
  skippedReason?: string
}

export interface TechnicalCrawlIndexability {
  /** Pages that redirect to a different final URL. */
  redirectingPages: number
  /** Redirect chains with more than one hop (pre-final URL). */
  longRedirectChains: number
  missingCanonicals: number
  nonOkPages: Array<{ url: string; status: number }>
}

export interface TechnicalSamplePage {
  url: string
  status: number
  title: string | null
  metaDescription: string | null
  canonical: string | null
  wordCount: number
  imagesTotal: number
  imagesWithAlt: number
  loadTimeMs: number
  redirectChain: string[]
  schemaTypes: string[]
  /**
   * Free-form issue flags surfaced for this URL — derived from page-level
   * data on the server so the dashboard doesn't have to recompute. Each
   * entry is { code, message }.
   */
  issues: Array<{ code: string; message: string }>
}

export interface TechnicalCrawlResult {
  domain: string
  startedAt: string
  finishedAt: string
  durationSeconds: number
  costUsd: number
  summary: TechnicalCrawlSummary
  lighthouse: TechnicalCrawlLighthouse
  schemaCoverage: SchemaCoverageMatrix
  indexability: TechnicalCrawlIndexability
  samplePages: TechnicalSamplePage[]
  errors: string[]
}

export class TechnicalCrawlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TechnicalCrawlError"
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function pageIssues(page: CrawledPage, thinThreshold: number): Array<{
  code: string
  message: string
}> {
  const issues: Array<{ code: string; message: string }> = []
  if (page.status >= 400 || page.status === 0) {
    issues.push({
      code: "non_2xx_status",
      message: `HTTP ${page.status || "fetch failed"}`,
    })
  }
  if (!page.title || page.title.trim().length === 0) {
    issues.push({ code: "missing_title", message: "Page has no <title>" })
  } else if (page.title.length > 70) {
    issues.push({
      code: "long_title",
      message: `Title is ${page.title.length} chars (over 70)`,
    })
  } else if (page.title.length < 20) {
    issues.push({
      code: "short_title",
      message: `Title is only ${page.title.length} chars (under 20)`,
    })
  }
  if (!page.metaDescription || page.metaDescription.trim().length === 0) {
    issues.push({
      code: "missing_meta_description",
      message: "Page has no meta description",
    })
  } else if (page.metaDescription.length > 160) {
    issues.push({
      code: "long_meta_description",
      message: `Meta description is ${page.metaDescription.length} chars (over 160)`,
    })
  }
  if (!page.canonical || page.canonical.trim().length === 0) {
    issues.push({
      code: "missing_canonical",
      message: "No canonical URL declared",
    })
  }
  if (page.h1s.length === 0) {
    issues.push({ code: "missing_h1", message: "Page has no <h1>" })
  } else if (page.h1s.length > 1) {
    issues.push({
      code: "multiple_h1s",
      message: `Page has ${page.h1s.length} <h1> tags`,
    })
  }
  if (page.imagesTotal > 0 && page.imagesWithAlt < page.imagesTotal) {
    const missing = page.imagesTotal - page.imagesWithAlt
    issues.push({
      code: "images_missing_alt",
      message: `${missing}/${page.imagesTotal} images missing alt text`,
    })
  }
  if (page.wordCount > 0 && page.wordCount < thinThreshold) {
    issues.push({
      code: "thin_content",
      message: `Only ${page.wordCount} words on page`,
    })
  }
  if (page.spaShellDetected) {
    issues.push({
      code: "spa_shell",
      message: "Empty body detected — page may rely on client-side rendering",
    })
  }
  if (page.redirectChain.length > 1) {
    issues.push({
      code: "redirect_chain",
      message: `Redirect chain has ${page.redirectChain.length} hops`,
    })
  }
  if (page.schemaTypes.length === 0) {
    issues.push({
      code: "no_structured_data",
      message: "No JSON-LD detected on page",
    })
  }
  return issues
}

/**
 * Pick the persisted sample slice. Strategy: every page with at least one
 * issue, sorted by issue count desc, then by URL for stability. Capped at
 * SAMPLE_PAGES_CAP. Falls back to "first N OK pages" when the site has zero
 * issues (rare but possible).
 */
function pickSamplePages(
  pages: CrawledPage[],
  thinThreshold: number,
): TechnicalSamplePage[] {
  const enriched = pages.map((p) => ({
    page: p,
    issues: pageIssues(p, thinThreshold),
  }))
  const withIssues = enriched
    .filter((e) => e.issues.length > 0)
    .sort((a, b) => {
      if (b.issues.length !== a.issues.length) {
        return b.issues.length - a.issues.length
      }
      return a.page.url.localeCompare(b.page.url)
    })
  const chosen =
    withIssues.length > 0
      ? withIssues.slice(0, SAMPLE_PAGES_CAP)
      : enriched.slice(0, SAMPLE_PAGES_CAP)

  return chosen.map(({ page, issues }) => ({
    url: page.finalUrl || page.url,
    status: page.status,
    title: page.title,
    metaDescription: page.metaDescription,
    canonical: page.canonical,
    wordCount: page.wordCount,
    imagesTotal: page.imagesTotal,
    imagesWithAlt: page.imagesWithAlt,
    loadTimeMs: page.loadTimeMs,
    redirectChain: page.redirectChain,
    schemaTypes: page.schemaTypes,
    issues,
  }))
}

function buildSummary(crawl: CrawlResults): TechnicalCrawlSummary {
  const okPages = crawl.pages.filter((p) => p.status >= 200 && p.status < 300)
  return {
    totalPages: crawl.pages.length,
    okPages: okPages.length,
    nonOkPages: crawl.nonOkPages.length,
    missingTitles: crawl.missingTitles.length,
    missingDescriptions: crawl.missingDescriptions.length,
    missingCanonicals: crawl.missingCanonicals.length,
    duplicateTitleGroups: crawl.duplicateTitles.length,
    duplicateDescriptionGroups: crawl.duplicateDescriptions.length,
    thinContentPages: crawl.thinContentPages.length,
    spaShellPages: crawl.spaShellPages.length,
    imageAltCoveragePercent: crawl.imageAltCoveragePercent,
    sitemapSize: crawl.sitemapUrls.length,
    crawlDelaySec: crawl.crawlDelaySec,
    statusCodeDistribution: crawl.statusCodeDistribution,
  }
}

function buildIndexability(crawl: CrawlResults): TechnicalCrawlIndexability {
  let redirecting = 0
  let longChains = 0
  for (const page of crawl.pages) {
    if (page.redirected) redirecting += 1
    if (page.redirectChain.length > 2) longChains += 1
  }
  return {
    redirectingPages: redirecting,
    longRedirectChains: longChains,
    missingCanonicals: crawl.missingCanonicals.length,
    nonOkPages: crawl.nonOkPages.slice(0, 50),
  }
}

/**
 * Pick PSI URL set: homepage + a handful of representative crawled pages
 * across the service / location / blog buckets if available. Capped at
 * PAGESPEED_URL_CAP to keep wall time predictable on routine runs.
 */
function pickPageSpeedUrls(
  domain: string,
  pages: CrawledPage[],
): { homepageUrl: string; urls: string[] } {
  const stripped = domain.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "")
  const homepageUrl = `https://${stripped}/`
  const urls: string[] = []
  const seen = new Set<string>()
  for (const page of pages) {
    if (page.status < 200 || page.status >= 300) continue
    const url = page.finalUrl || page.url
    if (seen.has(url)) continue
    seen.add(url)
    urls.push(url)
    if (urls.length >= PAGESPEED_URL_CAP) break
  }
  if (!seen.has(homepageUrl)) {
    urls.unshift(homepageUrl)
    if (urls.length > PAGESPEED_URL_CAP) urls.pop()
  }
  return { homepageUrl, urls }
}

async function runPageSpeed(
  domain: string,
  pages: CrawledPage[],
): Promise<TechnicalCrawlLighthouse> {
  const { urls } = pickPageSpeedUrls(domain, pages)
  // runPageSpeedAudit's `topGscPages` parameter is misnamed but happily
  // accepts any URL list — it'll merge the homepage and de-dupe.
  const report = await runPageSpeedAudit({
    domain,
    topGscPages: urls,
  })

  const failures: Array<{ url: string; reason: string }> = []
  const persistedPages: TechnicalCrawlLighthouse["pages"] = []
  for (const p of report.pages) {
    if (p.error) {
      failures.push({ url: p.url, reason: p.error })
      continue
    }
    if (!p.mobile) continue
    persistedPages.push({
      url: p.url,
      performanceScore: p.mobile.performanceScore,
      lcpMs: p.mobile.lcpMs,
      inpMs: p.mobile.inpMs,
      cls: p.mobile.cls,
      ttfbMs: p.mobile.ttfbMs,
    })
  }

  return {
    averageMobileScore: report.aggregates.averageMobileScore,
    homepageMobileScore: report.aggregates.homepageMobileScore,
    pages: persistedPages,
    failures,
    skippedReason: report.skippedReason,
  }
}

// ── Public entry point ────────────────────────────────────────────────────

export interface RunTechnicalCrawlOptions {
  /** Domain or URL to crawl. Scheme + path are stripped before the crawl. */
  domain: string
}

/**
 * Run the full technical-crawl pipeline. Wraps everything in `withAuditCost`
 * so DataForSEO charges roll up into `costUsd`. Throws TechnicalCrawlError
 * on any fatal step (crawl failure); recoverable failures (PSI down) are
 * captured in the result's `errors` array.
 */
export async function runTechnicalCrawl(
  opts: RunTechnicalCrawlOptions,
): Promise<TechnicalCrawlResult> {
  const startedAt = new Date()
  const cost = createCostAccumulator()
  const errors: string[] = []

  return withAuditCost(cost, async () => {
    let crawl: CrawlResults
    try {
      crawl = await crawlSite({
        domain: opts.domain,
        options: { mode: "sample" },
      })
    } catch (err) {
      if (err instanceof CrawlError) {
        throw new TechnicalCrawlError(err.message)
      }
      throw err
    }

    let lighthouse: TechnicalCrawlLighthouse
    try {
      lighthouse = await runPageSpeed(opts.domain, crawl.pages)
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown"
      errors.push(`PageSpeed pass failed: ${msg}`)
      lighthouse = {
        averageMobileScore: null,
        homepageMobileScore: null,
        pages: [],
        failures: [],
        skippedReason: `PageSpeed pass errored: ${msg}`,
      }
    }

    // Carry PSI per-URL failures over so they surface in the dashboard
    // alongside any pipeline-level error string.
    for (const f of lighthouse.failures) {
      errors.push(`PageSpeed: ${f.url} — ${f.reason}`)
    }

    const finishedAt = new Date()
    const durationSeconds = Math.max(
      1,
      Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000),
    )

    return {
      domain: crawl.domain,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationSeconds,
      costUsd: Number(totalCostUsd(cost).toFixed(4)),
      summary: buildSummary(crawl),
      lighthouse,
      schemaCoverage: crawl.schemaCoverageMatrix,
      indexability: buildIndexability(crawl),
      samplePages: pickSamplePages(crawl.pages, 300),
      errors,
    }
  })
}

// ── Schedule math ─────────────────────────────────────────────────────────

/**
 * Compute the next time a subscription should fire. Day-of-month is clamped
 * to the target month's length (e.g. day=31 in February → last day of Feb).
 * "Past today" always rolls to the next period — the routine catches up on
 * missed runs by firing them on the next tick after the laptop wakes up.
 *
 * Stored UTC. We anchor day-boundary math to the user's timezone so e.g.
 * "monthly on the 1st" fires on midnight ET, not midnight UTC.
 */
export function computeNextRunAt(
  frequency: "weekly" | "monthly",
  opts: { dayOfWeek?: number | null; dayOfMonth?: number | null; from?: Date },
): Date {
  const anchor = opts.from ?? new Date()
  if (frequency === "weekly") {
    if (opts.dayOfWeek == null) {
      throw new Error("dayOfWeek required for weekly schedule")
    }
    return nextWeekly(anchor, opts.dayOfWeek)
  }
  if (opts.dayOfMonth == null) {
    throw new Error("dayOfMonth required for monthly schedule")
  }
  return nextMonthly(anchor, opts.dayOfMonth)
}

function nextWeekly(from: Date, dayOfWeek: number): Date {
  // Move to 00:00 UTC, then advance to the requested weekday strictly in
  // the future. We lean on UTC rather than the user's tz because the
  // routine ticks daily anyway — the time-of-day knob was deliberately
  // dropped from the UI.
  const next = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()),
  )
  const today = next.getUTCDay()
  let delta = (dayOfWeek - today + 7) % 7
  if (delta === 0) delta = 7
  next.setUTCDate(next.getUTCDate() + delta)
  return next
}

function nextMonthly(from: Date, dayOfMonth: number): Date {
  const year = from.getUTCFullYear()
  const month = from.getUTCMonth()
  // Try this month first. If the requested day is in the past (or doesn't
  // exist this month after clamping), advance to next month.
  const thisMonth = clampedMonthly(year, month, dayOfMonth)
  if (thisMonth.getTime() > from.getTime()) return thisMonth
  return clampedMonthly(year, month + 1, dayOfMonth)
}

function clampedMonthly(year: number, monthOffset: number, day: number): Date {
  const safeYear = year + Math.floor(monthOffset / 12)
  const safeMonth = ((monthOffset % 12) + 12) % 12
  // Last day of safeMonth = day 0 of safeMonth+1.
  const lastDay = new Date(Date.UTC(safeYear, safeMonth + 1, 0)).getUTCDate()
  const clamped = Math.min(Math.max(1, day), lastDay)
  return new Date(Date.UTC(safeYear, safeMonth, clamped))
}
