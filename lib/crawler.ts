import "server-only"
import * as cheerio from "cheerio"
import { XMLParser } from "fast-xml-parser"
import type {
  CrawledPage,
  CrawlMode,
  CrawlResults,
} from "@/lib/types"

/**
 * SEO crawler for the Audit tab.
 *
 * Uses cheerio + native fetch (no headless browser). Rationale is captured in
 * CLAUDE.md's External APIs section: for the data points we need — status
 * codes, titles, meta descriptions, canonicals, H1/H2/H3, JSON-LD, image alt
 * coverage, internal links, word count — raw HTML is sufficient. Pages that
 * turn out to be client-rendered SPA shells are flagged as a finding rather
 * than re-fetched with a headless browser; that flag is itself SEO-relevant
 * because Googlebot's initial render may see the same empty body.
 *
 * Crawl modes (see `CrawlMode`):
 *   - "full"   — crawl every URL discovered in the sitemap (subject to the
 *                FULL_MAX_PAGES_CEILING safety net so a runaway crawl can't
 *                blow the 300s function timeout). Default for production audits.
 *   - "sample" — cap at 50 prioritized URLs. Fast-path for testing.
 *
 * Limits (baked in so the crawl fits comfortably inside Vercel's 300s Pro
 * function timeout):
 *   - max 5 concurrent fetches
 *   - 8s per-page fetch timeout
 *   - max 5 redirects per URL
 *   - small inter-batch delay (>= robots.txt Crawl-delay if present)
 *
 * The crawl is mobile-first (Googlebot mobile UA) — this matches Google's
 * real indexing behavior and occasionally trips cloaked or desktop-only
 * experiences, which is itself signal.
 */

const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.109 Mobile Safari/537.36 (compatible; HarbingerSEOAudit/1.0; +https://harbinger-seo-tool.vercel.app)"
const ROBOTS_UA_TOKEN = "Googlebot"

const PAGE_FETCH_TIMEOUT_MS = 8_000
const SITEMAP_FETCH_TIMEOUT_MS = 6_000
const ROBOTS_FETCH_TIMEOUT_MS = 5_000
const SAMPLE_MAX_PAGES = 50
const DEFAULT_CONCURRENCY = 5
const MAX_REDIRECTS = 5
const THIN_CONTENT_THRESHOLD = 300
/** Default minimum delay between batches (ms). Overridden by robots.txt. */
const DEFAULT_INTER_BATCH_DELAY_MS = 200
/** Hard ceiling on robots.txt crawl-delay we'll honor (seconds). Beyond this, we cap so the function can finish. */
const MAX_HONORED_CRAWL_DELAY_SEC = 5
/**
 * Hard ceiling for full-mode crawls. The Audit / Initial Strategy workflows
 * both call into this — 50k-page runaway crawls would blow Vercel's 300s
 * timeout. At 5 concurrent fetches × ~2-3s/page typical we can afford
 * ~200-400 pages comfortably; this ceiling is set well above that to give
 * space for fast sites and below the function timeout for slow ones.
 */
const FULL_MAX_PAGES_CEILING = 2_000

const RECOMMENDED_SCHEMA_TYPES = [
  "LocalBusiness",
  "Service",
  "Organization",
  "BreadcrumbList",
  "Review",
  "FAQPage",
] as const

/**
 * Schema types that don't help a local business rank — they're auto-generated
 * by themes (logo image, blog post markup, author bio) and don't substitute
 * for LocalBusiness / Service / Review. Used to flag pages whose only
 * structured data is decorative.
 */
const NON_MEANINGFUL_SCHEMA_TYPES = new Set([
  "Article",
  "BlogPosting",
  "NewsArticle",
  "WebPage",
  "WebSite",
  "Person",
  "ImageObject",
])

export interface CrawlOptions {
  /** Max pages to fetch. Used by `sample` mode (capped at 50) or as a manual ceiling in `full` mode. */
  maxPages?: number
  /** Concurrent in-flight requests. Capped at 5. */
  concurrency?: number
  /**
   * Crawl mode. Defaults to `"full"` (every sitemap URL up to the safety
   * ceiling). Use `"sample"` for fast iteration during development.
   */
  mode?: CrawlMode
  /**
   * Legacy alias for `mode === "full"`. Retained because the Onboarding /
   * Initial Strategy workflow already passes `unlimited: true`.
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

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── robots.txt ─────────────────────────────────────────────────────────────

interface RobotsInfo {
  sitemaps: string[]
  /** Crawl-delay in seconds (0 when no rule applies). */
  crawlDelaySec: number
}

/**
 * Parse robots.txt. We extract `Sitemap:` lines (host-wide, regardless of
 * user-agent block) and the most-specific `Crawl-delay` for our UA token.
 * Crawl-delay rules:
 *   - A `User-agent: Googlebot` block beats the wildcard.
 *   - Within a matching block, the FIRST Crawl-delay wins.
 *   - Values are clamped to MAX_HONORED_CRAWL_DELAY_SEC so a hostile
 *     `Crawl-delay: 60` can't kill the function timeout.
 */
function parseRobotsTxt(text: string): RobotsInfo {
  const sitemaps: string[] = []
  let wildcardDelay: number | null = null
  let uaSpecificDelay: number | null = null

  const lines = text.split(/\r?\n/)
  let activeUas: string[] = []

  for (const rawLine of lines) {
    // Strip comments + whitespace.
    const line = rawLine.replace(/#.*$/, "").trim()
    if (!line) continue

    const sitemapMatch = line.match(/^Sitemap:\s*(\S+)\s*$/i)
    if (sitemapMatch) {
      sitemaps.push(sitemapMatch[1])
      continue
    }

    const uaMatch = line.match(/^User-agent:\s*(.+)$/i)
    if (uaMatch) {
      const ua = uaMatch[1].trim().toLowerCase()
      // Consecutive User-agent lines accumulate into one group.
      activeUas =
        activeUas.length > 0 && !activeUas.includes(ua)
          ? [...activeUas, ua]
          : [ua]
      continue
    }

    const delayMatch = line.match(/^Crawl-delay:\s*([\d.]+)/i)
    if (delayMatch && activeUas.length > 0) {
      const delay = Number.parseFloat(delayMatch[1])
      if (!Number.isFinite(delay) || delay < 0) continue
      const matchesUa = activeUas.some(
        (u) => u === ROBOTS_UA_TOKEN.toLowerCase(),
      )
      const matchesWildcard = activeUas.some((u) => u === "*")
      if (matchesUa && uaSpecificDelay === null) uaSpecificDelay = delay
      if (matchesWildcard && wildcardDelay === null) wildcardDelay = delay
      continue
    }

    // Any other directive starts/continues the current block — no-op.
  }

  const chosen =
    uaSpecificDelay ?? wildcardDelay ?? 0
  const crawlDelaySec = Math.min(
    Math.max(0, chosen),
    MAX_HONORED_CRAWL_DELAY_SEC,
  )
  return { sitemaps, crawlDelaySec }
}

async function fetchRobots(origin: string): Promise<RobotsInfo> {
  const url = `${origin}/robots.txt`
  try {
    const res = await fetchWithTimeout(url, ROBOTS_FETCH_TIMEOUT_MS, {
      redirect: "follow",
    })
    if (!res.ok) return { sitemaps: [], crawlDelaySec: 0 }
    const text = await res.text()
    return parseRobotsTxt(text)
  } catch {
    return { sitemaps: [], crawlDelaySec: 0 }
  }
}

// ── Sitemap discovery + parsing ────────────────────────────────────────────

/**
 * Parse a sitemap.xml (or sitemap index) and return a flat list of URLs.
 * Recursively traverses sitemap-index files (depth-limited so a
 * misconfigured site can't drag the crawler into an infinite loop).
 */
async function parseSitemap(
  url: string,
  depth = 0,
  visited = new Set<string>(),
): Promise<string[]> {
  if (visited.has(url) || depth > 3) return []
  visited.add(url)

  let res: Response
  try {
    res = await fetchWithTimeout(url, SITEMAP_FETCH_TIMEOUT_MS, {
      redirect: "follow",
    })
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
    return (
      host === target ||
      host.endsWith(`.${target}`) ||
      target.endsWith(`.${host}`)
    )
  } catch {
    return false
  }
}

// ── Per-page parsing helpers ───────────────────────────────────────────────

/**
 * Walk a JSON-LD value tree and pull every distinct @type. Handles arrays,
 * @graph, and nested objects.
 */
function collectSchemaTypes(
  node: unknown,
  out: Set<string> = new Set(),
): Set<string> {
  if (Array.isArray(node)) {
    for (const n of node) collectSchemaTypes(n, out)
    return out
  }
  if (!node || typeof node !== "object") return out
  const obj = node as Record<string, unknown>
  const t = obj["@type"]
  if (typeof t === "string") out.add(t)
  else if (Array.isArray(t))
    for (const v of t) if (typeof v === "string") out.add(v)
  if (Array.isArray(obj["@graph"])) collectSchemaTypes(obj["@graph"], out)
  return out
}

/**
 * Returns parsed JSON-LD blocks AND the union of all @type values seen.
 * Blocks that fail to JSON.parse are silently dropped.
 */
function extractSchema($: cheerio.CheerioAPI): {
  types: string[]
  blocks: unknown[]
} {
  const blocks: unknown[] = []
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
    blocks.push(parsed)
    collectSchemaTypes(parsed, types)
  })
  return { types: [...types], blocks }
}

/** Rough SPA-shell detector: body text < 50 chars and a known framework root. */
function detectSpaShell($: cheerio.CheerioAPI): boolean {
  const bodyText = $("body").text().replace(/\s+/g, " ").trim()
  if (bodyText.length >= 50) return false
  const rootSelectors = [
    "#root",
    "#__next",
    "#app",
    "[data-reactroot]",
    "[ng-app]",
  ]
  return rootSelectors.some((sel) => $(sel).length > 0)
}

function countWords(text: string): number {
  const cleaned = text.replace(/\s+/g, " ").trim()
  if (!cleaned) return 0
  return cleaned.split(" ").length
}

function collectHeadings(
  $: cheerio.CheerioAPI,
  selector: string,
): string[] {
  const out: string[] = []
  $(selector).each((_, el) => {
    const t = $(el).text().replace(/\s+/g, " ").trim()
    if (t) out.push(t)
  })
  return out
}

/**
 * Returns true when a page's schema set is "decorative-only" — every type is
 * one of NON_MEANINGFUL_SCHEMA_TYPES. Empty schema sets also count as
 * missing-meaningful-schema (the page has no structured data at all).
 */
function isMissingMeaningfulSchema(schemaTypes: string[]): boolean {
  if (schemaTypes.length === 0) return true
  return schemaTypes.every((t) => NON_MEANINGFUL_SCHEMA_TYPES.has(t))
}

interface FetchResult {
  response: Response
  redirectChain: string[]
  finalUrl: string
}

/**
 * Manually follow redirects so we can record the intermediate URL chain.
 * native fetch with `redirect: "follow"` swallows the chain — we'd only see
 * the start + end. Stops at MAX_REDIRECTS to defend against loops.
 */
async function fetchFollowingRedirects(
  url: string,
  timeoutMs: number,
): Promise<FetchResult> {
  const chain: string[] = [url]
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetchWithTimeout(current, timeoutMs, {
      redirect: "manual",
    })
    const status = res.status
    if (status >= 300 && status < 400) {
      const location = res.headers.get("location")
      if (!location) {
        return { response: res, redirectChain: chain, finalUrl: current }
      }
      let nextUrl: string
      try {
        nextUrl = new URL(location, current).toString()
      } catch {
        return { response: res, redirectChain: chain, finalUrl: current }
      }
      // Drain the redirect body so the connection can be reused.
      try {
        await res.arrayBuffer()
      } catch {
        // Ignore drain failures — the response is being discarded anyway.
      }
      if (chain.includes(nextUrl)) {
        // Cycle — stop and return the redirect response as the final state.
        return { response: res, redirectChain: chain, finalUrl: current }
      }
      chain.push(nextUrl)
      current = nextUrl
      continue
    }
    return { response: res, redirectChain: chain, finalUrl: current }
  }
  // Exceeded MAX_REDIRECTS — fetch the last URL once more (non-manual) so we
  // have a body to surface.
  const res = await fetchWithTimeout(current, timeoutMs)
  return { response: res, redirectChain: chain, finalUrl: current }
}

function emptyPage(url: string, loadTimeMs: number): CrawledPage {
  return {
    url,
    finalUrl: url,
    status: 0,
    redirected: false,
    redirectChain: [url],
    title: null,
    metaDescription: null,
    metaRobots: null,
    canonical: null,
    h1s: [],
    h2s: [],
    h3s: [],
    schemaTypes: [],
    schemaBlocks: [],
    imagesTotal: 0,
    imagesWithAlt: 0,
    internalLinksOut: [],
    wordCount: 0,
    loadTimeMs,
    spaShellDetected: false,
  }
}

async function crawlOne(url: string, domain: string): Promise<CrawledPage> {
  const startedAt = Date.now()

  let fetched: FetchResult
  try {
    fetched = await fetchFollowingRedirects(url, PAGE_FETCH_TIMEOUT_MS)
  } catch (err) {
    const loadTimeMs = Date.now() - startedAt
    return {
      ...emptyPage(url, loadTimeMs),
      error: err instanceof Error ? err.message : "fetch failed",
    }
  }

  const { response: res, redirectChain, finalUrl } = fetched
  const redirected = redirectChain.length > 1
  const status = res.status

  if (!res.ok) {
    return {
      ...emptyPage(url, Date.now() - startedAt),
      finalUrl,
      redirected,
      redirectChain,
      status,
    }
  }

  const contentType = res.headers.get("content-type") ?? ""
  if (!/text\/html|application\/xhtml/.test(contentType)) {
    return {
      ...emptyPage(url, Date.now() - startedAt),
      finalUrl,
      redirected,
      redirectChain,
      status,
      error: `non-HTML content-type: ${contentType}`,
    }
  }

  let html: string
  try {
    html = await res.text()
  } catch (err) {
    return {
      ...emptyPage(url, Date.now() - startedAt),
      finalUrl,
      redirected,
      redirectChain,
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

  const h1s = collectHeadings($, "h1")
  const h2s = collectHeadings($, "h2")
  const h3s = collectHeadings($, "h3")

  const { types: schemaTypes, blocks: schemaBlocks } = extractSchema($)

  const imgs = $("img")
  let imagesWithAlt = 0
  imgs.each((_, el) => {
    const alt = $(el).attr("alt")
    if (typeof alt === "string" && alt.trim().length > 0) imagesWithAlt++
  })

  const internalLinksOutSet = new Set<string>()
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href")
    if (!href) return
    try {
      const resolved = new URL(href, finalUrl).toString()
      if (isSameDomain(resolved, domain)) internalLinksOutSet.add(resolved)
    } catch {
      // Ignore unparsable hrefs.
    }
  })

  const bodyText = $("body").clone()
  bodyText.find("script, style, noscript, template").remove()
  const wordCount = countWords(bodyText.text())

  const spaShellDetected = detectSpaShell($)
  const loadTimeMs = Date.now() - startedAt

  return {
    url,
    finalUrl,
    status,
    redirected,
    redirectChain,
    title,
    metaDescription,
    metaRobots,
    canonical,
    h1s,
    h2s,
    h3s,
    schemaTypes,
    schemaBlocks,
    imagesTotal: imgs.length,
    imagesWithAlt,
    internalLinksOut: [...internalLinksOutSet],
    wordCount,
    loadTimeMs,
    spaShellDetected,
  }
}

/**
 * Run `fn` over `items` in fixed-size batches with a per-batch concurrency
 * cap. After each batch we sleep for `interBatchDelayMs` so the target
 * server isn't pounded; this is also where we honor robots.txt Crawl-delay.
 * Preserves input order in the output.
 */
async function batchedMap<T, U>(
  items: T[],
  batchSize: number,
  interBatchDelayMs: number,
  fn: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results: U[] = new Array(items.length)
  for (let start = 0; start < items.length; start += batchSize) {
    const slice = items.slice(start, start + batchSize)
    const batchResults = await Promise.all(
      slice.map((item, i) => fn(item, start + i)),
    )
    for (let i = 0; i < batchResults.length; i++) {
      results[start + i] = batchResults[i]
    }
    // Skip the delay after the last batch.
    if (start + batchSize < items.length) {
      await sleep(interBatchDelayMs)
    }
  }
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
 * Main entry point. Discovers the sitemap, crawls every URL it reports (or
 * a 50-URL prioritized sample in `mode: "sample"`), and returns an aggregate
 * report.
 *
 * Throws `CrawlError` if the sitemap can't be discovered at all and the
 * homepage isn't reachable — without a URL set we'd return a useless report
 * pretending the site is a single page.
 */
export async function crawlSite(params: {
  domain: string
  options?: CrawlOptions
}): Promise<CrawlResults> {
  const startedAt = Date.now()
  const domain = normalizeDomain(params.domain)
  const origin = originFor(domain)

  const opts = params.options ?? {}
  const requestedMode: CrawlMode | undefined = opts.mode
  const legacyUnlimited = opts.unlimited === true
  const mode: CrawlMode =
    requestedMode ?? (legacyUnlimited ? "full" : "full")

  const concurrency = Math.min(
    opts.concurrency ?? DEFAULT_CONCURRENCY,
    DEFAULT_CONCURRENCY,
  )

  // Discover sitemaps (robots.txt Sitemap: lines + default paths). Robots.txt
  // also gives us crawl-delay so we know how long to wait between batches.
  const robots = await fetchRobots(origin)
  const sitemapCandidateSet = new Set<string>(robots.sitemaps)
  sitemapCandidateSet.add(`${origin}/sitemap.xml`)
  sitemapCandidateSet.add(`${origin}/sitemap_index.xml`)
  const sitemapCandidates = [...sitemapCandidateSet]

  const sitemapUrlsRaw: string[] = []
  for (const candidate of sitemapCandidates) {
    const urls = await parseSitemap(candidate)
    if (urls.length > 0) sitemapUrlsRaw.push(...urls)
  }

  const sitemapUrls = [...new Set(sitemapUrlsRaw)].filter((u) =>
    isSameDomain(u, domain),
  )
  if (sitemapUrls.length === 0) {
    // Nothing in the sitemap and homepage may still be reachable. Seed with
    // the origin so the crawl produces at least one row of evidence.
    sitemapUrls.push(`${origin}/`)
  }

  // Decide what to crawl based on mode.
  let toCrawl: string[]
  let appliedMaxPages: number
  if (mode === "sample") {
    appliedMaxPages = Math.min(opts.maxPages ?? SAMPLE_MAX_PAGES, SAMPLE_MAX_PAGES)
    toCrawl = prioritizeUrls(sitemapUrls, appliedMaxPages)
  } else {
    appliedMaxPages = Math.min(
      opts.maxPages ?? FULL_MAX_PAGES_CEILING,
      FULL_MAX_PAGES_CEILING,
    )
    toCrawl = [...new Set(sitemapUrls)].slice(0, appliedMaxPages)
  }

  const interBatchDelayMs = Math.max(
    DEFAULT_INTER_BATCH_DELAY_MS,
    Math.round(robots.crawlDelaySec * 1000),
  )

  console.log(
    `[crawler] domain=${domain} mode=${mode} sitemap_urls=${sitemapUrls.length} crawling=${toCrawl.length} concurrency=${concurrency} crawl_delay=${robots.crawlDelaySec}s batch_delay=${interBatchDelayMs}ms`,
  )

  const pages = await batchedMap(
    toCrawl,
    concurrency,
    interBatchDelayMs,
    (url) => crawlOne(url, domain),
  )

  const okPages = pages.filter((p) => p.status >= 200 && p.status < 300)
  const nonOkPages = pages
    .filter((p) => p.status === 0 || p.status < 200 || p.status >= 300)
    .map((p) => ({ url: p.finalUrl || p.url, status: p.status }))

  const statusCodeDistribution: Record<string, number> = {}
  for (const p of pages) {
    const key = String(p.status)
    statusCodeDistribution[key] = (statusCodeDistribution[key] ?? 0) + 1
  }

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

  const pagesMissingMeaningfulSchema = okPages.filter((p) =>
    isMissingMeaningfulSchema(p.schemaTypes),
  ).length

  const totalImgs = okPages.reduce((s, p) => s + p.imagesTotal, 0)
  const totalImgsWithAlt = okPages.reduce((s, p) => s + p.imagesWithAlt, 0)
  const imageAltCoveragePercent = totalImgs
    ? Math.round((totalImgsWithAlt / totalImgs) * 100)
    : 100

  const crawlDurationMs = Date.now() - startedAt
  console.log(
    `[crawler] domain=${domain} mode=${mode} done in ${crawlDurationMs}ms, ${okPages.length}/${pages.length} ok, ${nonOkPages.length} errors`,
  )

  return {
    domain,
    mode,
    sitemapUrls,
    crawledCount: pages.length,
    maxPages: appliedMaxPages,
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
    statusCodeDistribution,
    pagesMissingMeaningfulSchema,
    crawlDelaySec: robots.crawlDelaySec,
  }
}
