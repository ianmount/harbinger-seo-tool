import "server-only"
import { XMLParser } from "fast-xml-parser"

/**
 * Sitemap + robots.txt discovery.
 *
 * Lifted from the legacy cheerio-based crawler (`lib/crawler.ts`, removed in
 * the DataForSEO On-Page migration). Robots/sitemap endpoints are public XML
 * and rarely WAF-protected, so native fetch with browser-typical headers is
 * still fine for them — we only swapped the *page* crawl over to DataForSEO.
 */

const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.109 Mobile Safari/537.36"
const ROBOTS_UA_TOKEN = "Googlebot"

const SITEMAP_FETCH_TIMEOUT_MS = 6_000
const ROBOTS_FETCH_TIMEOUT_MS = 5_000
/** Hard cap on robots.txt crawl-delay we'll honor (seconds). */
const MAX_HONORED_CRAWL_DELAY_SEC = 5

export interface SitemapDiscovery {
  sitemapUrls: string[]
  crawlDelaySec: number
}

export interface RobotsInfo {
  sitemaps: string[]
  /** Crawl-delay in seconds (0 when no rule applies). */
  crawlDelaySec: number
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
        // Browser-typical headers reduce false-positive WAF blocks on
        // robots/sitemap endpoints. Even though most CDNs serve these
        // statically, some sites (Cloudflare bot fight) still 403 plain
        // fetch UAs — mirroring real Chrome gets us past the basic rules.
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Sec-Ch-Ua":
          '"Not(A:Brand";v="99", "Google Chrome";v="120", "Chromium";v="120"',
        "Sec-Ch-Ua-Mobile": "?1",
        "Sec-Ch-Ua-Platform": '"Android"',
        ...(init?.headers ?? {}),
      },
    })
  } finally {
    clearTimeout(timer)
  }
}

export function parseRobotsTxt(text: string): RobotsInfo {
  const sitemaps: string[] = []
  let wildcardDelay: number | null = null
  let uaSpecificDelay: number | null = null

  const lines = text.split(/\r?\n/)
  let activeUas: string[] = []

  for (const rawLine of lines) {
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
  }

  const chosen = uaSpecificDelay ?? wildcardDelay ?? 0
  const crawlDelaySec = Math.min(
    Math.max(0, chosen),
    MAX_HONORED_CRAWL_DELAY_SEC,
  )
  return { sitemaps, crawlDelaySec }
}

export async function discoverRobots(origin: string): Promise<RobotsInfo> {
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

/**
 * Parse a sitemap.xml (or sitemap index) and return a flat list of URLs.
 * Recursively traverses sitemap-index files, depth-limited so a misconfigured
 * site can't drag the parser into an infinite loop.
 */
export async function parseSitemap(
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
 * Combined helper: read robots.txt for sitemap directives + crawl-delay,
 * then probe the conventional `/sitemap.xml` and `/sitemap_index.xml`
 * locations, and return the deduped union of every URL discovered. The
 * URLs are filtered to the prospect's domain so off-site sitemap entries
 * (e.g. a CMS that lists external URLs) don't end up in the crawl queue.
 */
export async function discoverSitemap(
  domain: string,
): Promise<SitemapDiscovery> {
  const origin = originFor(domain)
  const robots = await discoverRobots(origin)

  const candidateSet = new Set<string>(robots.sitemaps)
  candidateSet.add(`${origin}/sitemap.xml`)
  candidateSet.add(`${origin}/sitemap_index.xml`)
  const candidates = [...candidateSet]

  const raw: string[] = []
  for (const candidate of candidates) {
    const urls = await parseSitemap(candidate)
    if (urls.length > 0) raw.push(...urls)
  }

  const sitemapUrls = [...new Set(raw)].filter((u) => isSameDomain(u, domain))
  return {
    sitemapUrls,
    crawlDelaySec: robots.crawlDelaySec,
  }
}

export { normalizeDomain, originFor, isSameDomain }
