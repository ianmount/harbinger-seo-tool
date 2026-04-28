import { NextResponse } from "next/server"
import { z } from "zod"
import { getPartner } from "@/lib/airtable"
import { crawlSite, CrawlError } from "@/lib/audit-crawl"
import {
  GSCError,
  getTopPagesPaginated,
  partnerWebsiteToGscSiteUrl,
} from "@/lib/gsc"
import {
  runInitialStrategy,
  type CarryoverInputPage,
  type RunInitialStrategyResult,
} from "@/lib/initial-strategy"
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
 * GSC traffic floor for the content-carryover analysis. A crawled URL is
 * sent to Claude only when its 180-day GSC stats clear EITHER threshold.
 * Permissive on impressions (≥50) is intentional — pages ranking on page 2
 * or 3 are usually the best refresh candidates, and they tend to show
 * impressions without clicks. Homepage is always included regardless of
 * GSC data because GSC URL canonicalization is unreliable for the bare
 * domain.
 */
const GSC_LOOKBACK_DAYS = 180
const GSC_MIN_CLICKS = 1
const GSC_MIN_IMPRESSIONS = 50

/** Drop trailing slash, lowercase host. Used to join crawl URLs to GSC URLs. */
function normalizeUrlForJoin(raw: string): string | null {
  try {
    const u = new URL(raw)
    const path = u.pathname.replace(/\/+$/, "") || "/"
    return `${u.protocol}//${u.hostname.toLowerCase()}${path}${u.search}`
  } catch {
    return null
  }
}

/** YYYY-MM-DD, UTC, N days before today. */
function isoDateNDaysAgo(n: number): string {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000)
  return d.toISOString().slice(0, 10)
}

/** YYYY-MM-DD for "today" in UTC. */
function isoToday(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Onboarding → Initial Strategy.
 *
 * Pipeline:
 *  1. Load Partner from Airtable.
 *  2. Crawl Partner.website with `unlimited: true` so the URL mapping covers
 *     every page on the current site (capped at the crawler's safety ceiling).
 *  3. Parse the indented sitemap text into a tree.
 *  4. Parse the keyword list (CSV header row supported, or one keyword per line).
 *  5. Call runInitialStrategy → returns keyword/url/internal-link tables.
 *  6. Respond with the structured InitialStrategyOutput. The UI renders preview
 *     tables and downloads the XLSX from the same JSON.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

const bodySchema = z.object({
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

/**
 * Parse the keyword input. Accepts:
 *   - CSV with a header row containing a "Keyword" column (case-insensitive).
 *     Other columns are ignored — we only need the keyword text.
 *   - One keyword per line (no header).
 *
 * Returns deduplicated keywords in input order. Empty rows are skipped. Falls
 * back to one-per-line parsing if a CSV header isn't found.
 */
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
    // CSV mode — use the column the header points to.
    for (let i = 1; i < lines.length; i++) {
      const cells = lines[i].split(",").map((c) => c.trim().replace(/^"|"$/g, ""))
      const kw = cells[headerKeywordIdx]
      if (!kw) continue
      const key = kw.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(kw)
    }
    return out
  }

  // One-per-line mode. Strip optional leading "- " or "* " bullets.
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
  const { partnerId, sitemapText, keywordsText } = parsed.data

  // 1. Load partner.
  let partner: Awaited<ReturnType<typeof getPartner>>
  try {
    partner = await getPartner(partnerId)
  } catch (err: unknown) {
    console.error("[api/onboarding/initial-strategy] partner lookup failed:", err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load partner" },
      { status: 500 },
    )
  }
  if (!partner) {
    return NextResponse.json(
      { error: `Partner ${partnerId} not found` },
      { status: 404 },
    )
  }

  // 2. Parse sitemap text.
  let sitemapRoot
  try {
    sitemapRoot = parseSitemapText(sitemapText)
  } catch (err: unknown) {
    if (err instanceof SitemapParseError) {
      return NextResponse.json(
        {
          error: `Sitemap parse error: ${err.message}`,
          line: err.line,
        },
        { status: 400 },
      )
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Sitemap parse failed" },
      { status: 400 },
    )
  }

  // 3. Parse keyword list.
  const keywords = parseKeywordsText(keywordsText)
  if (keywords.length === 0) {
    return NextResponse.json(
      {
        error:
          "No keywords found. Paste a CSV with a 'Keyword' column or one keyword per line.",
      },
      { status: 400 },
    )
  }

  // 4. Crawl current site (uncapped within the 2000-page safety ceiling).
  // Keep the per-page metadata for the carryover analysis — earlier
  // versions threw it away and only kept the URL list.
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
      // Keep the OK pages — non-OK URLs (404, 5xx) shouldn't be carryover
      // candidates regardless of GSC traffic.
      if (page.status >= 200 && page.status < 300) {
        crawledPagesByUrl.set(url, page)
      }
    }
    crawledUrls = [...urlSet]
  } catch (err: unknown) {
    if (err instanceof CrawlError) {
      return NextResponse.json(
        { error: `Crawl failed: ${err.message}` },
        { status: 502 },
      )
    }
    console.error("[api/onboarding/initial-strategy] crawl failed:", err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Crawl failed" },
      { status: 500 },
    )
  }
  if (crawledUrls.length === 0) {
    return NextResponse.json(
      {
        error: `No URLs were crawled from ${partner.website}. Check that the site is reachable and exposes a sitemap.`,
      },
      { status: 502 },
    )
  }

  // 5. Pull GSC search analytics by page over the lookback window. Optional —
  // a GSC failure (no refresh token, site not verified, partner not in GSC)
  // degrades to metadata-only carryover analysis without aborting the job.
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
    console.warn("[api/onboarding/initial-strategy] GSC fetch failed:", err)
  }

  // 6. Build the carryover-eligible page set.
  //
  // - When GSC is available: filter to crawled pages whose normalized URL
  //   matches a GSC row meeting the click/impression threshold. Always
  //   include the homepage (GSC's URL canonicalization for bare domains
  //   is flaky enough that homepage joins miss often).
  // - When GSC is unavailable: every crawled page becomes eligible; Claude
  //   judges purely on crawl metadata.
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
      // Non-OK page (404/5xx) or otherwise filtered. Auto-retire — Claude
      // shouldn't waste tokens on broken URLs.
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
      // Metadata-only mode: every crawled page is eligible.
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

  console.log(
    `[api/onboarding/initial-strategy] carryover gsc=${gscEnabled} eligible=${carryoverPages.length} auto-retire=${autoRetirePages.length} crawled=${crawledUrls.length}`,
  )

  // 7. Run the Claude strategy step.
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
  } catch (err: unknown) {
    console.error("[api/onboarding/initial-strategy] strategy failed:", err)
    const message = err instanceof Error ? err.message : "Strategy generation failed"
    return NextResponse.json({ error: message }, { status: 502 })
  }

  const fullOutput: InitialStrategyOutput = {
    ...result.output,
    gscEnabled,
    gscNotice,
    gscLookbackDays: GSC_LOOKBACK_DAYS,
  }

  return NextResponse.json({ result: fullOutput })
}
