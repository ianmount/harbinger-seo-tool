import "server-only"
import { z } from "zod"
import { createCostAccumulator, withAuditCost } from "@/lib/audit-cost"
import { detectBrokenInternalLinks } from "@/lib/audit-broken-links"
import { crawlSite } from "@/lib/audit-crawl"
import { detectHeadingIssues } from "@/lib/audit-h-tags"
import {
  buildSynthesisPrompt,
  detectMetaUnreliable,
  injectOrganicSessionsChart,
  SYNTHESIS_SYSTEM_PROMPT,
} from "@/lib/audit-synthesis"
import { detectUrlStructureIssues } from "@/lib/audit-url-structure"
import { deriveBrandTokens, splitBrandedQueries } from "@/lib/branded-keywords"
import { detectCannibalization } from "@/lib/cannibalization"
import { callClaude } from "@/lib/claude"
import { backlinkProfile, backlinksTimeseriesSummary } from "@/lib/dataforseo"
import { GA4Error, getMonthlyOrganic, getSeoReport, listProperties } from "@/lib/ga4"
import { findGa4PropertyCandidates } from "@/lib/ga4-site-match"
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
import type { TaskRunner } from "@/lib/inngest/functions"
import {
  isCancelRequested,
  JobCancelledError,
  updateProgress,
} from "@/lib/jobs"
import { runPageSpeedAudit } from "@/lib/pagespeed"
import type {
  AssessmentAuditResult,
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
 * Audit task — the full pre-sales audit pipeline (gather → synthesize → render).
 *
 * Lifted from the legacy /api/audit/run + /api/audit/synthesize routes. The
 * NDJSON streaming is gone — progress now writes to `background_jobs.progress`
 * via `updateProgress(jobId, ...)`, which the JobsTray + /audits/<id> page
 * read by polling the row.
 *
 * Result shape matches the legacy `AssessmentAuditResult` so the existing
 * dashboard at /audits/[audit_id] renders unchanged.
 */

const targetMarketSchema = z.object({
  city: z.string().min(1),
  state: z.string().min(1),
})

export const AuditInputSchema = z.object({
  websiteUrl: z.string().min(3),
  partnerName: z.string().optional().default(""),
  priorityServices: z.string().optional().default(""),
  negativeKeywords: z.string().optional().default(""),
  existingTargetKeywords: z.string().optional().default(""),
  idealCustomer: z.string().optional().default(""),
  targetMarkets: z.array(targetMarketSchema).max(10).optional().default([]),
  crawlMode: z.enum(["full", "sample"]).optional().default("full"),
})

export type AuditInput = z.infer<typeof AuditInputSchema>

// ── Helpers (lifted from legacy route) ─────────────────────────────────────

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

const STAGE_LABELS: Record<string, string> = {
  starting: "Starting audit",
  gsc_ready: "Search Console data ready",
  crawl_progress: "Crawling site",
  crawl_done: "Crawl complete",
  pagespeed_done: "PageSpeed complete",
  parallel_done: "Gather phase complete",
  index_coverage_started: "Checking indexation coverage",
  index_coverage_done: "Indexation coverage complete",
  synthesizing: "Synthesizing findings",
}

// ── GSC / GA4 dual-account resolution ──────────────────────────────────────

interface GscFetchResult {
  data: AssessmentGscData
  account: GoogleAccount
  queryPages: GSCQueryRow[]
}

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
  if (matched.length > 0) return matched[0]

  const okResults = results.filter((r) => r.sites !== null)
  if (okResults.length > 0) {
    const fallback =
      okResults.find((r) => r.account === "assessments") ?? okResults[0]
    return {
      account: fallback.account,
      siteUrl: partnerWebsiteToGscSiteUrl(websiteUrl),
    }
  }
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
      getTopQueriesPaginated({ account, siteUrl, startDate, endDate, maxRows: 100 }),
      getTopPagesPaginated({ account, siteUrl, startDate, endDate, maxRows: 50 }),
      getDailyClicks({ account, siteUrl, startDate, endDate }),
      getQueries({ account, siteUrl, startDate, endDate, rowLimit: 5000 }).catch(
        () => [] as GSCQueryRow[],
      ),
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error"
    warnings.push(
      `Indexation coverage check failed; the audit will continue without indexation data. (${msg})`,
    )
  }
}

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
  if (matched.length > 0) return matched[0]

  const okResults = results.filter((r) => r.properties !== null)
  if (okResults.length > 0) {
    warnings.push(
      `GA4 access not yet granted for this property. Please ensure ${emailFor("assessments")} or ${emailFor("partners")} has been added as a Viewer on the GA4 property. The audit will continue using GSC + crawl data only.`,
    )
    return null
  }
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

// ── Orchestration ──────────────────────────────────────────────────────────

async function gatherAuditData(
  jobId: string,
  body: AuditInput,
): Promise<AuditDataBundle> {
  const startedAt = Date.now()
  // Plain progress write — never throws. Used by tight-loop callbacks
  // (e.g. crawl_progress fires every poll cycle) where mid-iteration
  // cancellation isn't safe.
  const writeProgress = (key: string, detail?: string) =>
    updateProgress(jobId, {
      stage: STAGE_LABELS[key] ?? key.replace(/_/g, " "),
      detail,
    }).catch(() => {
      /* progress updates are best-effort; never fail the run on a write */
    })

  // Stage checkpoint — writes progress AND throws if the user requested
  // cancellation. Called between expensive sub-phases (crawl done, GSC
  // done, etc.) so the runner can observe the cancellation cleanly.
  const stage = async (key: string, detail?: string) => {
    await writeProgress(key, detail)
    if (await isCancelRequested(jobId)) {
      throw new JobCancelledError(jobId)
    }
  }

  const warnings: string[] = []
  const websiteUrl = cleanWebsite(body.websiteUrl)
  await stage("starting", `domain=${websiteUrl}`)

  const gscPromise = tryFetchGsc(websiteUrl, warnings)
  const ga4Promise = tryFetchGa4(websiteUrl, warnings)
  const crawlPromise = crawlSite({
    domain: websiteUrl,
    options: { mode: body.crawlMode },
    onProgress: (p) =>
      void writeProgress(
        "crawl_progress",
        `pages=${p.pagesCrawled} queue=${p.pagesInQueue} status=${p.status}`,
      ),
  })
  const backlinkPromise = backlinkProfile(websiteUrl).catch((err) => {
    const msg = err instanceof Error ? err.message : "Unknown error"
    warnings.push(
      `Backlink profile fetch failed; the audit will continue without it. (${msg})`,
    )
    return null
  })
  // Backlink growth pattern. Independent of the profile pull so a slow/failed
  // timeseries call doesn't hold up the rest of the gather phase. Failures
  // are silent — the synthesis prompt skips the growth section when the
  // series is empty.
  const backlinkTimeseriesPromise = backlinksTimeseriesSummary(websiteUrl).catch(
    (err) => {
      const msg = err instanceof Error ? err.message : "Unknown error"
      warnings.push(
        `Backlink growth-pattern fetch failed; the audit will continue without the growth chart. (${msg})`,
      )
      return [] as Awaited<ReturnType<typeof backlinksTimeseriesSummary>>
    },
  )
  const pageSpeedPromise = (async () => {
    const gscRes = await gscPromise
    await writeProgress("gsc_ready")
    const topGscPages = gscRes?.data
      ? [...gscRes.data.topPages]
          .sort((a, b) => b.impressions - a.impressions)
          .map((p) => p.page)
      : []
    const ps = await runPageSpeedAudit({ domain: websiteUrl, topGscPages })
    if (ps.skippedReason) warnings.push(ps.skippedReason)
    await writeProgress("pagespeed_done", `urls=${ps.pages.length}`)
    return ps
  })()

  crawlPromise
    .then((c) =>
      void writeProgress(
        "crawl_done",
        `pages=${c.crawledCount} sitemap=${c.sitemapUrls.length}`,
      ),
    )
    .catch(() => {
      /* surfaced by Promise.all below */
    })

  const [
    gscRes,
    ga4Res,
    crawlRes,
    backlinkProfileRes,
    backlinkTimeseriesRes,
    pageSpeedRes,
  ] = await Promise.all([
    gscPromise,
    ga4Promise,
    crawlPromise,
    backlinkPromise,
    backlinkTimeseriesPromise,
    pageSpeedPromise,
  ])

  const gsc = gscRes?.data ?? null
  const gscQueryPages = gscRes?.queryPages ?? []
  const ga4 = ga4Res
  const crawl: CrawlReport = crawlRes
  // Merge the timeseries onto the profile so downstream consumers see one
  // shape. Profile fields stay null when the profile pull failed; we only
  // attach the timeseries when both succeeded.
  const backlinkProfileData: BacklinkProfile | null =
    backlinkProfileRes && backlinkTimeseriesRes.length > 0
      ? { ...backlinkProfileRes, monthlyTimeseries: backlinkTimeseriesRes }
      : backlinkProfileRes
  const pageSpeed: PageSpeedReport = pageSpeedRes
  await stage(
    "parallel_done",
    `pages=${crawl.crawledCount} ga4=${ga4 ? "yes" : "no"} gsc=${gsc ? "yes" : "no"}`,
  )

  if (gsc && gscRes) {
    await stage("index_coverage_started")
    await tryFetchIndexCoverage(gscRes.account, gsc, crawl.sitemapUrls, warnings)
    await stage("index_coverage_done")
  }

  const cannibalization = detectCannibalization({
    pages: crawl.pages,
    partnerName: body.partnerName?.trim() || null,
    gscQueryPages,
    targetMarkets: body.targetMarkets,
  })
  const urlStructureIssues = detectUrlStructureIssues(crawl)
  const brokenInternalLinks = detectBrokenInternalLinks(crawl)
  const headingIssues = detectHeadingIssues(crawl)
  // Brand-token derivation runs even when GSC is absent (no-op in that case)
  // so the synthesis prompt can still mention which tokens were considered.
  const brandTokens = deriveBrandTokens({
    partnerName: body.partnerName,
    websiteUrl,
  })
  if (gsc) {
    gsc.brandedSplit = splitBrandedQueries(gsc.topQueries, brandTokens)
  }
  const metaCheck = detectMetaUnreliable(crawl)
  if (metaCheck.unreliable) {
    const titlePct = Math.round(metaCheck.missingTitleRate * 100)
    const descPct = Math.round(metaCheck.missingDescriptionRate * 100)
    warnings.push(
      `Title/description detection looks unreliable: ${titlePct}% of crawled pages were missing <title> and ${descPct}% were missing meta descriptions. That pattern is implausible for a real site and usually means the site's CDN/WAF served stripped responses to the crawler, or the site renders its <head> via JavaScript. The audit will skip the missing-titles/descriptions finding — open the homepage in your browser, view source, and confirm whether the tags are present in the static HTML.`,
    )
  }

  const gatherDurationSeconds = Math.round((Date.now() - startedAt) / 1000)
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
    headingIssues,
    metaUnreliable: metaCheck.unreliable,
    crawlSummary: summarizeCrawl(crawl),
  }
}

async function synthesizeAudit(
  jobId: string,
  bundle: AuditDataBundle,
): Promise<{ markdown: string; durationSeconds: number }> {
  if (await isCancelRequested(jobId)) {
    throw new JobCancelledError(jobId)
  }
  await updateProgress(jobId, {
    stage: STAGE_LABELS.synthesizing,
  }).catch(() => {})
  const startedAt = Date.now()
  const prompt = buildSynthesisPrompt({
    body: {
      websiteUrl: bundle.body.websiteUrl,
      partnerName: bundle.body.partnerName,
      priorityServices: bundle.body.priorityServices,
      negativeKeywords: bundle.body.negativeKeywords,
      existingTargetKeywords: bundle.body.existingTargetKeywords,
      idealCustomer: bundle.body.idealCustomer,
      targetMarkets: bundle.body.targetMarkets,
    },
    gsc: bundle.gsc,
    ga4: bundle.ga4,
    crawl: bundle.crawl,
    cannibalization: bundle.cannibalization,
    pageSpeed: bundle.pageSpeed,
    backlinkProfile: bundle.backlinkProfile,
    urlStructureIssues: bundle.urlStructureIssues,
    brokenInternalLinks: bundle.brokenInternalLinks,
    headingIssues: bundle.headingIssues,
    metaUnreliable: bundle.metaUnreliable,
  })
  let markdown = await callClaude(prompt, {
    model: "claude-opus-4-7",
    system: SYNTHESIS_SYSTEM_PROMPT,
    maxTokens: 12_000,
  })
  markdown = injectOrganicSessionsChart(markdown, bundle.ga4)
  return {
    markdown,
    durationSeconds: Math.round((Date.now() - startedAt) / 1000),
  }
}

export const runAuditTask: TaskRunner = async ({ jobId, job }) => {
  const parsed = AuditInputSchema.safeParse(job.input)
  if (!parsed.success) {
    throw new Error(
      `Invalid audit input: ${JSON.stringify(parsed.error.flatten())}`,
    )
  }
  const input = parsed.data

  const cost = createCostAccumulator()
  const result = await withAuditCost(cost, async () => {
    const bundle = await gatherAuditData(jobId, input)
    const { markdown, durationSeconds } = await synthesizeAudit(jobId, bundle)
    const auditResult: AssessmentAuditResult = {
      websiteUrl: bundle.websiteUrl,
      generatedAt: bundle.generatedAt,
      auditMarkdown: markdown,
      warnings: bundle.warnings,
      gscData: bundle.gsc,
      ga4Data: bundle.ga4,
      crawlSummary: bundle.crawlSummary,
      cannibalization: bundle.cannibalization,
      durationSeconds: bundle.gatherDurationSeconds + durationSeconds,
    }
    return auditResult
  })

  console.log(
    `[audit:done] job=${jobId} domain=${result.websiteUrl} duration=${result.durationSeconds}s cost=$${(cost.dataforseoUsd + cost.claudeUsd).toFixed(2)}`,
  )

  return {
    result: { audit: result, costUsd: cost.dataforseoUsd + cost.claudeUsd },
    resultPath: `/audits/${jobId}`,
  }
}
