import "server-only"
import { z } from "zod"
import { getPartner } from "@/lib/partners"
import { crawlSite, CrawlError } from "@/lib/audit-crawl"
import {
  GSCError,
  getTopPagesPaginated,
  partnerWebsiteToGscSiteUrl,
} from "@/lib/gsc"
import type { TaskRunner } from "@/lib/inngest/functions"
import {
  runInitialStrategy,
  type CarryoverInputPage,
  type RunInitialStrategyResult,
} from "@/lib/initial-strategy"
import {
  isCancelRequested,
  JobCancelledError,
  updateProgress,
} from "@/lib/jobs"
import {
  parseSitemapText,
  SitemapParseError,
} from "@/lib/sitemap-parser"
import type {
  ContentCarryover,
  CrawledPage,
  GSCTopPageRow,
  InitialStrategyOutput,
} from "@/lib/types"

/**
 * Initial Strategy task. Lifted from the legacy
 * /api/onboarding/initial-strategy route. Same pipeline, exposed as a
 * TaskRunner so it can run as a background job: load partner → crawl site
 * → fetch 180-day GSC → build carryover-eligible page set → call Claude.
 *
 * Cooperative cancellation checkpoints sit between each phase. If the
 * user clicks Stop, the next phase boundary throws JobCancelledError.
 */

const GSC_LOOKBACK_DAYS = 180
const GSC_MIN_CLICKS = 1
const GSC_MIN_IMPRESSIONS = 50

export const InitialStrategyInputSchema = z.object({
  partnerId: z.string().min(1, "partnerId is required"),
  sitemapText: z
    .string()
    .min(1, "sitemapText is required")
    .max(50_000, "sitemapText is too long (50k char max)"),
  keywordsText: z
    .string()
    .min(1, "keywordsText is required")
    .max(50_000, "keywordsText is too long (50k char max)"),
})

export type InitialStrategyInput = z.infer<typeof InitialStrategyInputSchema>

function normalizeUrlForJoin(raw: string): string | null {
  try {
    const u = new URL(raw)
    const path = u.pathname.replace(/\/+$/, "") || "/"
    return `${u.protocol}//${u.hostname.toLowerCase()}${path}${u.search}`
  } catch {
    return null
  }
}

function isoDateNDaysAgo(n: number): string {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000)
  return d.toISOString().slice(0, 10)
}
function isoToday(): string {
  return new Date().toISOString().slice(0, 10)
}

function parseKeywordsText(input: string): string[] {
  const lines = input
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
  if (lines.length === 0) return []

  const firstCells = lines[0].split(",").map((c) => c.trim().toLowerCase())
  const headerKeywordIdx = firstCells.findIndex(
    (c) => c === "keyword" || c === "keywords",
  )
  const seen = new Set<string>()
  const out: string[] = []
  if (headerKeywordIdx !== -1 && lines.length > 1) {
    for (let i = 1; i < lines.length; i++) {
      const cells = lines[i]
        .split(",")
        .map((c) => c.trim().replace(/^"|"$/g, ""))
      const kw = cells[headerKeywordIdx]
      if (!kw) continue
      const key = kw.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(kw)
    }
    return out
  }
  for (const line of lines) {
    const kw = line.replace(/^[-*]\s+/, "").replace(/^"|"$/g, "")
    if (!kw) continue
    const key = kw.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(kw)
  }
  return out
}

export const runInitialStrategyTask: TaskRunner = async ({ jobId, job }) => {
  const parsed = InitialStrategyInputSchema.safeParse(job.input)
  if (!parsed.success) {
    throw new Error(
      `Invalid initial-strategy input: ${JSON.stringify(parsed.error.flatten())}`,
    )
  }
  const { partnerId, sitemapText, keywordsText } = parsed.data

  const stage = async (label: string, detail?: string) => {
    if (await isCancelRequested(jobId)) throw new JobCancelledError(jobId)
    await updateProgress(jobId, { stage: label, detail }).catch(() => {})
  }

  // 1. Load partner.
  await stage("Loading partner")
  const partner = await getPartner(partnerId)
  if (!partner) {
    throw new Error(`Partner ${partnerId} not found`)
  }

  // 2. Parse sitemap text.
  let sitemapRoot
  try {
    sitemapRoot = parseSitemapText(sitemapText)
  } catch (err: unknown) {
    if (err instanceof SitemapParseError) {
      throw new Error(`Sitemap parse error (line ${err.line}): ${err.message}`)
    }
    throw err
  }

  // 3. Parse keyword list.
  const keywords = parseKeywordsText(keywordsText)
  if (keywords.length === 0) {
    throw new Error(
      "No keywords found. Paste a CSV with a 'Keyword' column or one keyword per line.",
    )
  }

  // 4. Crawl current site.
  await stage("Crawling current site", partner.website)
  let crawledUrls: string[]
  let crawledPagesByUrl: Map<string, CrawledPage>
  try {
    const report = await crawlSite({
      domain: partner.website,
      options: { unlimited: true },
    })
    const urlSet = new Set<string>()
    crawledPagesByUrl = new Map<string, CrawledPage>()
    for (const page of report.pages) {
      const url = page.finalUrl || page.url
      if (!url) continue
      urlSet.add(url)
      if (page.status >= 200 && page.status < 300) {
        crawledPagesByUrl.set(url, page)
      }
    }
    crawledUrls = [...urlSet]
  } catch (err: unknown) {
    if (err instanceof CrawlError) {
      throw new Error(`Crawl failed: ${err.message}`)
    }
    throw err
  }
  if (crawledUrls.length === 0) {
    throw new Error(
      `No URLs were crawled from ${partner.website}. Check that the site is reachable and exposes a sitemap.`,
    )
  }

  // 5. Pull GSC.
  await stage("Pulling 180-day GSC traffic")
  const gscStartDate = isoDateNDaysAgo(GSC_LOOKBACK_DAYS)
  const gscEndDate = isoToday()
  let gscRows: GSCTopPageRow[] = []
  let gscEnabled = false
  let gscNotice: string | null = null
  try {
    gscRows = await getTopPagesPaginated({
      account: "partners",
      siteUrl: partnerWebsiteToGscSiteUrl(partner.website),
      startDate: gscStartDate,
      endDate: gscEndDate,
    })
    gscEnabled = true
    if (gscRows.length === 0) {
      gscNotice =
        "GSC returned zero rows for the last 180 days — falling back to metadata-only carryover analysis."
    }
  } catch (err: unknown) {
    if (err instanceof GSCError) {
      gscNotice =
        err.code === "NO_REFRESH_TOKEN"
          ? "GSC refresh token not configured — carryover recommendations are based on crawl metadata only."
          : `GSC fetch failed (${err.message}) — carryover recommendations are based on crawl metadata only.`
    } else {
      gscNotice = `GSC fetch failed (${err instanceof Error ? err.message : "unknown"}) — carryover recommendations are based on crawl metadata only.`
    }
  }

  // 6. Build carryover-eligible page set.
  const gscByNormalizedUrl = new Map<string, GSCTopPageRow>()
  for (const row of gscRows) {
    const norm = normalizeUrlForJoin(row.page)
    if (norm) gscByNormalizedUrl.set(norm, row)
  }
  const homepageNormalized = normalizeUrlForJoin(
    partnerWebsiteToGscSiteUrl(partner.website),
  )

  const carryoverPages: CarryoverInputPage[] = []
  const autoRetirePages: ContentCarryover[] = []
  for (const url of crawledUrls) {
    const crawled = crawledPagesByUrl.get(url)
    if (!crawled) {
      autoRetirePages.push({
        oldUrl: url,
        recommendation: "retire",
        targetPagePath: null,
        newUrl: null,
        rationale: "Page returned a non-OK HTTP status during crawl.",
        title: "",
        wordCount: 0,
        gsc: null,
        autoGenerated: true,
      })
      continue
    }
    const normalized = normalizeUrlForJoin(url)
    const gscRow = normalized ? gscByNormalizedUrl.get(normalized) : undefined
    const isHomepage =
      !!normalized &&
      !!homepageNormalized &&
      normalized === homepageNormalized

    let qualifies: boolean
    let gscStats: CarryoverInputPage["gsc"]
    if (!gscEnabled) {
      qualifies = true
      gscStats = null
    } else if (gscRow) {
      qualifies =
        gscRow.clicks >= GSC_MIN_CLICKS ||
        gscRow.impressions >= GSC_MIN_IMPRESSIONS
      gscStats = {
        clicks: gscRow.clicks,
        impressions: gscRow.impressions,
        ctr: gscRow.ctr,
        position: gscRow.position,
      }
    } else {
      qualifies = isHomepage
      gscStats = null
    }

    if (!qualifies) {
      const impressions = gscRow?.impressions ?? 0
      const clicks = gscRow?.clicks ?? 0
      autoRetirePages.push({
        oldUrl: url,
        recommendation: "retire",
        targetPagePath: null,
        newUrl: null,
        rationale: `No qualifying GSC traffic in the last ${GSC_LOOKBACK_DAYS} days (clicks=${clicks}, impressions=${impressions}).`,
        title: crawled.title ?? "",
        wordCount: crawled.wordCount,
        gsc: gscRow
          ? {
              clicks: gscRow.clicks,
              impressions: gscRow.impressions,
              ctr: gscRow.ctr,
              position: gscRow.position,
            }
          : null,
        autoGenerated: true,
      })
      continue
    }

    carryoverPages.push({
      url,
      title: crawled.title ?? "",
      metaDescription: crawled.metaDescription ?? "",
      h1: crawled.h1s[0] ?? "",
      h2s: crawled.h2s,
      wordCount: crawled.wordCount,
      schemaTypes: crawled.schemaTypes,
      gsc: gscStats,
    })
  }

  // 7. Claude strategy step.
  await stage("Generating strategy with Claude", `${carryoverPages.length} carryover pages, ${keywords.length} keywords`)
  let result: RunInitialStrategyResult
  try {
    result = await runInitialStrategy({
      partner,
      sitemapRoot,
      sitemapRawText: sitemapText,
      keywords,
      crawledUrls,
      carryoverPages,
      autoRetirePages,
    })
  } catch (err) {
    throw new Error(
      err instanceof Error ? err.message : "Strategy generation failed",
    )
  }

  const fullOutput: InitialStrategyOutput = {
    ...result.output,
    gscEnabled,
    gscNotice,
    gscLookbackDays: GSC_LOOKBACK_DAYS,
  }

  return {
    result: { strategy: fullOutput },
    resultPath: `/onboarding/initial-strategy?job=${jobId}`,
  }
}
