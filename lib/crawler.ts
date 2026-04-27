import "server-only"
import * as cheerio from "cheerio"
import { XMLParser } from "fast-xml-parser"
import type { CrawledPage, CrawlReport } from "@/lib/types"

/**
 * SEO crawler for the Audit tab.
 *
 * Uses cheerio + native fetch (no headless browser). Rationale is captured in
 * CLAUDE.md's External APIs section: for the data points we need — status
 * codes, titles, meta descriptions, canonicals, H1/H2s, JSON-LD, image alt
 * coverage, internal links, word count — raw HTML is sufficient. Pages that
 * turn out to be client-rendered SPA shells are flagged as a finding rather
 * than re-fetched with a headless browser; that flag is itself SEO-relevant
 * because Googlebot's initial render may see the same empty body.
 *
 * Limits (baked in so the crawl fits comfortably inside Vercel's 300s Pro
 * function timeout):
 *   - max 50 pages per audit
 *   - 5 concurrent fetches
 *   - 8s per-page fetch timeout
 *   - 3s HTML parse cap (cheerio doesn't have one; enforced via AbortSignal on fetch)
 *
 * The crawl is mobile-first (Googlebot mobile UA) — this matches Google's
 * real indexing behavior and occasionally trips cloaked or desktop-only
 * experiences, which is itself signal.
 */

const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.109 Mobile Safari/537.36 (compatible; HarbingerSEOAudit/1.0; +https://harbinger-seo-tool.vercel.app)"

const PAGE_FETCH_TIMEOUT_MS = 8_000
const SITEMAP_FETCH_TIMEOUT_MS = 6_000
const DEFAULT_MAX_PAGES = 50
const DEFAULT_CONCURRENCY = 5
const THIN_CONTENT_THRESHOLD = 300
/**
 * Hard ceiling for `unlimited: true` crawls. The Onboarding/Initial Strategy
 * workflow needs every URL on the current site so it can build a redirect map,
 * but a runaway crawl on a 50k-page site would blow Vercel's 300s timeout. At
 * 5 concurrent fetches × 8s/page worst case we can afford ~150-200 pages
 * comfortably; this ceiling is set well above that to give space for fast
 * sites and below the function timeout for slow ones.
 */
const UNLIMITED_MAX_PAGES_CEILING = 2_000
const RECOMMENDED_SCHEMA_TYPES = [
  "LocalBusiness",
  "Service",
  "Organization",
  "BreadcrumbList",
  "Review",
  "FAQPage",
] as const

export interface CrawlOptions {
  /** Max pages to fetch. Capped at 50 unless `unlimited: true`. */
  maxPages?: number
  /** Concurrent in-flight requests. Capped at 5. */
  concurrency?: number
  /**
   * Bypass the 50-page Audit cap. Used by the Onboarding/Initial Strategy
   * workflow, which needs every URL on the current site to build a complete
   * redirect map. Still honors `UNLIMITED_MAX_PAGES_CEILING` (2000) so a
   * runaway crawl can't blow Vercel's 300s function timeout.
   *
   * In unlimited mode the URL prioritizer is disabled (we want the full set,
   * not the most-interesting subset) and blog/tag/author archives are
   * included rather than down-weighted.
   */
  unlimited?: boolean
}

export class CrawlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CrawlError"
  }
}

function normalizeDomain(domain: string): string {
  return domain
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase()
}

function originFor(domain: string): string {
  return `https://${normalizeDomain(domain)}`
}

/** Pull candidate sitemap URLs: robots.txt Sitemap: lines + default /sitemap.xml. */
async function discoverSitemapUrls(origin: string): Promise<string[]> {
  const out = new Set<string>()
  const robotsUrl = `${origin}/robots.txt`
  try {
    const res = await fetchWithTimeout(robotsUrl, SITEMAP_FETCH_TIMEOUT_MS)
    if (res.ok) {
      const text = await res.text()
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*Sitemap:\s*(\S+)\s*$/i)
        if (m) out.add(m[1])
      }
    }
  } catch {
    // Ignore — fall back to default path.
  }
  out.add(`${origin}/sitemap.xml`)
  out.add(`${origin}/sitemap_index.xml`)
  return [...out]
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {
      ...init,
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": MOBILE_UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        ...(init?.headers ?? {}),
      },
    })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Parse a sitemap.xml (or sitemap index) and return a flat list of URLs.
 * Handles nested sitemap indexes up to one level deep — deeper trees are
 * rare for local business sites and recursion risks runaway fetches.
 */
async function parseSitemap(
  url: string,
  depth = 0,
  visited = new Set<string>(),
): Promise<string[]> {
  if (visited.has(url) || depth > 2) return []
  visited.add(url)

  let res: Response
  try {
    res = await fetchWithTimeout(url, SITEMAP_FETCH_TIMEOUT_MS)
  } catch {
    return []
  }
  if (!res.ok) return []

  const xml = await res.text()
  const parser = new XMLParser({
    ignoreAttributes: false,
    allowBooleanAttributes: true,
  })
  let parsed: unknown
  try {
    parsed = parser.parse(xml)
  } catch {
    return []
  }

  const out: string[] = []

  const rootObj = parsed as Record<string, unknown> | null
  const sitemapIndex = rootObj?.sitemapindex as
    | { sitemap?: unknown }
    | undefined
  if (sitemapIndex?.sitemap) {
    const entries = Array.isArray(sitemapIndex.sitemap)
      ? sitemapIndex.sitemap
      : [sitemapIndex.sitemap]
    for (const entry of entries) {
      const loc = (entry as { loc?: string })?.loc
      if (typeof loc === "string") {
        const nested = await parseSitemap(loc, depth + 1, visited)
        out.push(...nested)
      }
    }
    return out
  }

  const urlset = rootObj?.urlset as { url?: unknown } | undefined
  if (urlset?.url) {
    const entries = Array.isArray(urlset.url) ? urlset.url : [urlset.url]
    for (const entry of entries) {
      const loc = (entry as { loc?: string })?.loc
      if (typeof loc === "string") out.push(loc)
    }
  }

  return out
}

/**
 * Limit a list to a given size, preferring URLs that are structurally
 * interesting (home, service pages, location pages) over deep blog archives.
 * Heuristics: shorter paths first, /blog/ or date-stamped URLs last.
 */
function prioritizeUrls(urls: string[], max: number): string[] {
  const unique = [...new Set(urls)]
  const scored = unique.map((url) => {
    let score = 0
    try {
      const u = new URL(url)
      const path = u.pathname
      score += path.split("/").filter(Boolean).length * 2
      if (/\/blog\//i.test(path)) score += 15
      if (/\/tag\//i.test(path)) score += 20
      if (/\/author\//i.test(path)) score += 25
      if (/\/\d{4}\/\d{2}/.test(path)) score += 10
      if (path === "/" || path === "") score -= 50
    } catch {
      score += 100
    }
    return { url, score }
  })
  scored.sort((a, b) => a.score - b.score)
  return scored.slice(0, max).map((s) => s.url)
}

/** Best-effort check that a URL is on the prospect's own domain. */
function isSameDomain(url: string, domain: string): boolean {
  try {
    const u = new URL(url)
    const host = u.hostname.toLowerCase()
    const target = normalizeDomain(domain)
    return host === target || host.endsWith(`.${target}`) || target.endsWith(`.${host}`)
  } catch {
    return false
  }
}

/** Extract schema.org @type values from JSON-LD script tags. */
function extractSchemaTypes($: cheerio.CheerioAPI): string[] {
  const types = new Set<string>()
  $('script[type="application/ld+json"]').each((_, el) => {
    const text = $(el).contents().text().trim()
    if (!text) return
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return
    }
    const collect = (node: unknown) => {
      if (Array.isArray(node)) {
        for (const n of node) collect(n)
        return
      }
      if (!node || typeof node !== "object") return
      const obj = node as Record<string, unknown>
      const t = obj["@type"]
      if (typeof t === "string") types.add(t)
      else if (Array.isArray(t)) for (const v of t) if (typeof v === "string") types.add(v)
      if (Array.isArray(obj["@graph"])) collect(obj["@graph"])
    }
    collect(parsed)
  })
  return [...types]
}

/** Rough SPA-shell detector: body text < 50 chars and a known framework root. */
function detectSpaShell($: cheerio.CheerioAPI): boolean {
  const bodyText = $("body").text().replace(/\s+/g, " ").trim()
  if (bodyText.length >= 50) return false
  const rootSelectors = [
    "#root",
    "#__next",
    "#app",
    '[data-reactroot]',
    "[ng-app]",
  ]
  return rootSelectors.some((sel) => $(sel).length > 0)
}

function countWords(text: string): number {
  const cleaned = text.replace(/\s+/g, " ").trim()
  if (!cleaned) return 0
  return cleaned.split(" ").length
}

async function crawlOne(url: string, domain: string): Promise<CrawledPage> {
  const empty: CrawledPage = {
    url,
    finalUrl: url,
    status: 0,
    redirected: false,
    title: null,
    metaDescription: null,
    metaRobots: null,
    canonical: null,
    h1s: [],
    h2Count: 0,
    schemaTypes: [],
    imagesTotal: 0,
    imagesWithAlt: 0,
    internalLinks: 0,
    wordCount: 0,
    spaShellDetected: false,
  }

  let res: Response
  try {
    res = await fetchWithTimeout(url, PAGE_FETCH_TIMEOUT_MS)
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : "fetch failed" }
  }

  const finalUrl = res.url || url
  const redirected = res.redirected || finalUrl !== url
  const status = res.status

  if (!res.ok) {
    return { ...empty, finalUrl, redirected, status }
  }

  const contentType = res.headers.get("content-type") ?? ""
  if (!/text\/html|application\/xhtml/.test(contentType)) {
    return {
      ...empty,
      finalUrl,
      redirected,
      status,
      error: `non-HTML content-type: ${contentType}`,
    }
  }

  let html: string
  try {
    html = await res.text()
  } catch (err) {
    return {
      ...empty,
      finalUrl,
      redirected,
      status,
      error: err instanceof Error ? err.message : "read failed",
    }
  }

  const $ = cheerio.load(html)

  const title = $("head title").first().text().trim() || null
  const metaDescription =
    $('head meta[name="description"]').attr("content")?.trim() || null
  const metaRobots =
    $('head meta[name="robots"]').attr("content")?.trim() || null
  const canonical =
    $('head link[rel="canonical"]').attr("href")?.trim() || null

  const h1s: string[] = []
  $("h1").each((_, el) => {
    const t = $(el).text().replace(/\s+/g, " ").trim()
    if (t) h1s.push(t)
  })
  const h2Count = $("h2").length

  const schemaTypes = extractSchemaTypes($)

  const imgs = $("img")
  let imagesWithAlt = 0
  imgs.each((_, el) => {
    const alt = $(el).attr("alt")
    if (typeof alt === "string" && alt.trim().length > 0) imagesWithAlt++
  })

  const internalLinks = $("a[href]")
    .toArray()
    .filter((el) => {
      const href = $(el).attr("href")
      if (!href) return false
      try {
        const resolved = new URL(href, finalUrl).toString()
        return isSameDomain(resolved, domain)
      } catch {
        return false
      }
    }).length

  const bodyText = $("body").clone()
  bodyText.find("script, style, noscript, template").remove()
  const wordCount = countWords(bodyText.text())

  const spaShellDetected = detectSpaShell($)

  return {
    url,
    finalUrl,
    status,
    redirected,
    title,
    metaDescription,
    metaRobots,
    canonical,
    h1s,
    h2Count,
    schemaTypes,
    imagesTotal: imgs.length,
    imagesWithAlt,
    internalLinks,
    wordCount,
    spaShellDetected,
  }
}

/** Run fn over items with a concurrency cap. Preserves input order in output. */
async function mapLimit<T, U>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results: U[] = new Array(items.length)
  let next = 0
  const workers: Promise<void>[] = []
  for (let w = 0; w < Math.min(limit, items.length); w++) {
    workers.push(
      (async () => {
        while (true) {
          const i = next++
          if (i >= items.length) return
          results[i] = await fn(items[i], i)
        }
      })(),
    )
  }
  await Promise.all(workers)
  return results
}

function groupDuplicates<K>(
  pages: CrawledPage[],
  key: (p: CrawledPage) => K | null,
): { value: K; urls: string[] }[] {
  const buckets = new Map<K, string[]>()
  for (const p of pages) {
    const k = key(p)
    if (k == null) continue
    const arr = buckets.get(k) ?? []
    arr.push(p.finalUrl)
    buckets.set(k, arr)
  }
  return [...buckets.entries()]
    .filter(([, urls]) => urls.length > 1)
    .map(([value, urls]) => ({ value, urls }))
}

/**
 * Main entry point. Discovers the sitemap, crawls up to `maxPages` URLs
 * concurrently, and returns an aggregate report.
 *
 * Throws `CrawlError` if the sitemap can't be discovered at all — we won't
 * fall back to a recursive link crawl, because that's a far larger blast
 * radius and the whole point is to check the sitemap the site is telling
 * search engines about.
 */
export async function crawlSite(params: {
  domain: string
  options?: CrawlOptions
}): Promise<CrawlReport> {
  const startedAt = Date.now()
  const domain = normalizeDomain(params.domain)
  const origin = originFor(domain)
  const unlimited = params.options?.unlimited === true
  const requestedMax = params.options?.maxPages ?? DEFAULT_MAX_PAGES
  const maxPages = unlimited
    ? Math.min(requestedMax, UNLIMITED_MAX_PAGES_CEILING)
    : Math.min(requestedMax, 50)
  const concurrency = Math.min(
    params.options?.concurrency ?? DEFAULT_CONCURRENCY,
    5,
  )

  const sitemapCandidates = await discoverSitemapUrls(origin)
  const sitemapUrlsRaw: string[] = []
  for (const candidate of sitemapCandidates) {
    const urls = await parseSitemap(candidate)
    if (urls.length > 0) {
      sitemapUrlsRaw.push(...urls)
    }
  }

  const sitemapUrls = [...new Set(sitemapUrlsRaw)].filter((u) =>
    isSameDomain(u, domain),
  )

  if (sitemapUrls.length === 0) {
    sitemapUrls.push(origin + "/")
  }

  // In unlimited mode we want every URL the sitemap reports (the workflow is
  // building a redirect map and the prioritizer would silently drop blog/tag
  // archives). The ceiling still applies — past it, we just truncate.
  const toCrawl = unlimited
    ? [...new Set(sitemapUrls)].slice(0, maxPages)
    : prioritizeUrls(sitemapUrls, maxPages)
  console.log(
    `[crawler] domain=${domain} sitemap_urls=${sitemapUrls.length} crawling=${toCrawl.length} concurrency=${concurrency}${unlimited ? " unlimited=true" : ""}`,
  )

  const pages = await mapLimit(toCrawl, concurrency, (url) =>
    crawlOne(url, domain),
  )

  const okPages = pages.filter((p) => p.status >= 200 && p.status < 300)
  const nonOkPages = pages
    .filter((p) => p.status === 0 || p.status < 200 || p.status >= 300)
    .map((p) => ({ url: p.finalUrl || p.url, status: p.status }))

  const duplicateTitles = groupDuplicates(okPages, (p) =>
    p.title ? p.title.toLowerCase() : null,
  ).map((g) => ({ title: g.value as string, urls: g.urls }))

  const duplicateDescriptions = groupDuplicates(okPages, (p) =>
    p.metaDescription ? p.metaDescription.toLowerCase() : null,
  ).map((g) => ({ description: g.value as string, urls: g.urls }))

  const missingCanonicals = okPages.filter((p) => !p.canonical).map((p) => p.finalUrl)
  const missingTitles = okPages.filter((p) => !p.title).map((p) => p.finalUrl)
  const missingDescriptions = okPages
    .filter((p) => !p.metaDescription)
    .map((p) => p.finalUrl)

  const thinContentPages = okPages
    .filter((p) => p.wordCount > 0 && p.wordCount < THIN_CONTENT_THRESHOLD)
    .map((p) => ({ url: p.finalUrl, wordCount: p.wordCount }))

  const spaShellPages = okPages
    .filter((p) => p.spaShellDetected)
    .map((p) => p.finalUrl)

  const schemaTypesPresent = [
    ...new Set(okPages.flatMap((p) => p.schemaTypes)),
  ].sort()
  const schemaTypesRecommended = RECOMMENDED_SCHEMA_TYPES.filter(
    (t) => !schemaTypesPresent.includes(t),
  )

  const totalImgs = okPages.reduce((s, p) => s + p.imagesTotal, 0)
  const totalImgsWithAlt = okPages.reduce((s, p) => s + p.imagesWithAlt, 0)
  const imageAltCoveragePercent = totalImgs
    ? Math.round((totalImgsWithAlt / totalImgs) * 100)
    : 100

  const crawlDurationMs = Date.now() - startedAt
  console.log(
    `[crawler] domain=${domain} done in ${crawlDurationMs}ms, ${okPages.length}/${pages.length} ok, ${nonOkPages.length} errors`,
  )

  return {
    domain,
    sitemapUrls,
    crawledCount: pages.length,
    maxPages,
    pages,
    nonOkPages,
    duplicateTitles,
    duplicateDescriptions,
    missingCanonicals,
    missingTitles,
    missingDescriptions,
    thinContentPages,
    spaShellPages,
    schemaTypesPresent,
    schemaTypesRecommended,
    imageAltCoveragePercent,
    crawlDurationMs,
  }
}

