import { NextResponse } from "next/server"
import { z } from "zod"
import { getPartner } from "@/lib/airtable"
import { crawlSite, CrawlError } from "@/lib/audit-crawl"
import {
  runInitialStrategy,
  type RunInitialStrategyResult,
} from "@/lib/initial-strategy"
import {
  parseSitemapText,
  SitemapParseError,
} from "@/lib/sitemap-parser"

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
  let crawledUrls: string[]
  try {
    const report = await crawlSite({
      domain: partner.website,
      options: { unlimited: true },
    })
    // Use the final (post-redirect) URLs and dedupe — we don't want the
    // mapping to redirect a 301-target to itself.
    const set = new Set<string>()
    for (const page of report.pages) {
      const url = page.finalUrl || page.url
      if (url) set.add(url)
    }
    crawledUrls = [...set]
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

  // 5. Run the Claude strategy step.
  let result: RunInitialStrategyResult
  try {
    result = await runInitialStrategy({
      partner,
      sitemapRoot,
      sitemapRawText: sitemapText,
      keywords,
      crawledUrls,
    })
  } catch (err: unknown) {
    console.error("[api/onboarding/initial-strategy] strategy failed:", err)
    const message = err instanceof Error ? err.message : "Strategy generation failed"
    return NextResponse.json({ error: message }, { status: 502 })
  }

  return NextResponse.json({ result: result.output })
}
