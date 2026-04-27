import "server-only"
import { env } from "@/lib/env"
import type {
  PageSpeedMetrics,
  PageSpeedOpportunity,
  PageSpeedReport,
  PageSpeedUrlResult,
} from "@/lib/types"

/**
 * Google PageSpeed Insights v5 client for the SEO Audit tab.
 *
 * Pulls Lighthouse + CrUX metrics for the homepage and the prospect's top GSC
 * pages. Mobile is the primary signal because Google ranks on mobile; desktop
 * is captured for context but never gates a finding by itself.
 *
 * Operational guardrails:
 *   - 24h in-memory cache per (URL, strategy). Surviving cold starts is not
 *     a goal — the cache exists to avoid hammering the API on retries within
 *     a single audit run.
 *   - Concurrency capped at 2 simultaneous requests. PSI rate-limits hard.
 *   - 60s per-request timeout; PSI can take 30-50s on a cold third-party site.
 *   - Without `PAGESPEED_API_KEY` set, the whole pass is skipped (returns a
 *     report flagged with `skippedReason`). With a key the free quota is
 *     25,000 calls/day, comfortably above the audit's 22-call ceiling.
 */

const PSI_ENDPOINT =
  "https://www.googleapis.com/pagespeedonline/v5/runPagespeed"
const REQUEST_TIMEOUT_MS = 60_000
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const MAX_CONCURRENT = 2
const MAX_GSC_PAGES = 10

type Strategy = "mobile" | "desktop"

// ── 24h in-memory cache ────────────────────────────────────────────────────
//
// Keyed by `${url}::${strategy}`. Per-instance only; cold starts reset it.
// That's intentional — see file header.

interface CacheEntry {
  metrics: PageSpeedMetrics | null
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()

function cacheKey(url: string, strategy: Strategy): string {
  return `${url}::${strategy}`
}

function readCache(url: string, strategy: Strategy): PageSpeedMetrics | null | undefined {
  const entry = cache.get(cacheKey(url, strategy))
  if (!entry) return undefined
  if (entry.expiresAt < Date.now()) {
    cache.delete(cacheKey(url, strategy))
    return undefined
  }
  return entry.metrics
}

function writeCache(
  url: string,
  strategy: Strategy,
  metrics: PageSpeedMetrics | null,
): void {
  cache.set(cacheKey(url, strategy), {
    metrics,
    expiresAt: Date.now() + CACHE_TTL_MS,
  })
}

// ── Simple async semaphore for concurrency cap ────────────────────────────

let inflight = 0
const waitQueue: Array<() => void> = []

async function acquireSlot(): Promise<void> {
  if (inflight < MAX_CONCURRENT) {
    inflight += 1
    return
  }
  await new Promise<void>((resolve) => waitQueue.push(resolve))
  inflight += 1
}

function releaseSlot(): void {
  inflight -= 1
  const next = waitQueue.shift()
  if (next) next()
}

// ── Fetch + parse ─────────────────────────────────────────────────────────

interface PsiAudit {
  id?: string
  title?: string
  numericValue?: number
  details?: {
    type?: string
    overallSavingsMs?: number
  }
}

interface PsiCruxMetric {
  percentile?: number
}

interface PsiResponse {
  lighthouseResult?: {
    categories?: { performance?: { score?: number | null } }
    audits?: Record<string, PsiAudit>
  }
  loadingExperience?: {
    metrics?: {
      INTERACTION_TO_NEXT_PAINT?: PsiCruxMetric
      LARGEST_CONTENTFUL_PAINT_MS?: PsiCruxMetric
      CUMULATIVE_LAYOUT_SHIFT_SCORE?: PsiCruxMetric
      EXPERIMENTAL_TIME_TO_FIRST_BYTE?: PsiCruxMetric
    }
  }
  error?: { code?: number; message?: string }
}

function pickOpportunities(
  audits: Record<string, PsiAudit> | undefined,
): PageSpeedOpportunity[] {
  if (!audits) return []
  const candidates: PageSpeedOpportunity[] = []
  for (const [id, a] of Object.entries(audits)) {
    if (!a || a.details?.type !== "opportunity") continue
    const savings = a.details.overallSavingsMs ?? a.numericValue
    if (typeof savings !== "number" || savings <= 0) continue
    candidates.push({
      id,
      title: a.title ?? id,
      estimatedSavingsMs: Math.round(savings),
    })
  }
  candidates.sort(
    (x, y) => (y.estimatedSavingsMs ?? 0) - (x.estimatedSavingsMs ?? 0),
  )
  return candidates.slice(0, 3)
}

function extractMetrics(json: PsiResponse): PageSpeedMetrics | null {
  const lh = json.lighthouseResult
  if (!lh) return null
  const rawScore = lh.categories?.performance?.score
  const performanceScore =
    typeof rawScore === "number" ? Math.round(rawScore * 100) : null

  const lcpAudit = lh.audits?.["largest-contentful-paint"]
  const clsAudit = lh.audits?.["cumulative-layout-shift"]
  const ttfbAudit = lh.audits?.["server-response-time"]

  // Field (CrUX) data takes precedence for INP — Lighthouse lab can't measure
  // INP reliably. LCP/CLS/TTFB use lab data because they're available even on
  // sites without enough CrUX traffic.
  const crux = json.loadingExperience?.metrics
  const inpFromCrux = crux?.INTERACTION_TO_NEXT_PAINT?.percentile

  return {
    performanceScore,
    lcpMs: typeof lcpAudit?.numericValue === "number" ? Math.round(lcpAudit.numericValue) : null,
    inpMs: typeof inpFromCrux === "number" ? Math.round(inpFromCrux) : null,
    cls:
      typeof clsAudit?.numericValue === "number"
        ? Math.round(clsAudit.numericValue * 1000) / 1000
        : null,
    ttfbMs:
      typeof ttfbAudit?.numericValue === "number"
        ? Math.round(ttfbAudit.numericValue)
        : null,
    opportunities: pickOpportunities(lh.audits),
  }
}

async function fetchOne(
  url: string,
  strategy: Strategy,
  apiKey: string,
): Promise<PageSpeedMetrics | null> {
  const cached = readCache(url, strategy)
  if (cached !== undefined) return cached

  const params = new URLSearchParams({
    url,
    strategy,
    category: "performance",
    key: apiKey,
  })
  const fullUrl = `${PSI_ENDPOINT}?${params.toString()}`

  await acquireSlot()
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(fullUrl, { signal: controller.signal })
    } finally {
      clearTimeout(timeout)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      console.warn(
        `[pagespeed] ${strategy} ${url}: HTTP ${res.status} ${text.slice(0, 200)}`,
      )
      writeCache(url, strategy, null)
      return null
    }
    const json = (await res.json()) as PsiResponse
    if (json.error) {
      console.warn(
        `[pagespeed] ${strategy} ${url}: API error ${json.error.code} ${json.error.message ?? ""}`,
      )
      writeCache(url, strategy, null)
      return null
    }
    const metrics = extractMetrics(json)
    writeCache(url, strategy, metrics)
    return metrics
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown"
    console.warn(`[pagespeed] ${strategy} ${url}: fetch failed (${msg})`)
    writeCache(url, strategy, null)
    return null
  } finally {
    releaseSlot()
  }
}

// ── Public helpers ────────────────────────────────────────────────────────

function canonicalize(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    const u = trimmed.startsWith("http") ? new URL(trimmed) : new URL(`https://${trimmed}`)
    // Strip fragments; keep query strings (Google treats them as distinct).
    u.hash = ""
    return u.toString()
  } catch {
    return null
  }
}

function homepageFromDomain(domain: string): string {
  // Domain may be "example.com" or "https://example.com/" — be liberal.
  const stripped = domain.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "")
  return `https://${stripped}/`
}

/**
 * Pick the URL set to audit: top GSC pages by impressions plus the homepage
 * if not already in the set. Capped at MAX_GSC_PAGES + 1.
 */
export function selectPageSpeedUrls(opts: {
  domain: string
  topGscPages: string[]
}): { homepageUrl: string; urls: string[] } {
  const homepageUrl = homepageFromDomain(opts.domain)
  const seen = new Set<string>()
  const urls: string[] = []

  // Top GSC pages first (preserve impression ordering).
  for (const raw of opts.topGscPages.slice(0, MAX_GSC_PAGES)) {
    const canonical = canonicalize(raw)
    if (!canonical) continue
    if (seen.has(canonical)) continue
    seen.add(canonical)
    urls.push(canonical)
  }
  // Add homepage if not already present.
  if (!seen.has(homepageUrl)) {
    seen.add(homepageUrl)
    urls.push(homepageUrl)
  }
  return { homepageUrl, urls }
}

function buildAggregates(
  pages: PageSpeedUrlResult[],
  homepageUrl: string,
): PageSpeedReport["aggregates"] {
  const lowScorePages: { url: string; score: number }[] = []
  const poorLcpPages: { url: string; lcpMs: number }[] = []
  const poorClsPages: { url: string; cls: number }[] = []
  let scoreSum = 0
  let scoreCount = 0
  let homepageMobileScore: number | null = null

  for (const p of pages) {
    const m = p.mobile
    if (!m) continue
    if (typeof m.performanceScore === "number") {
      scoreSum += m.performanceScore
      scoreCount += 1
      if (p.url === homepageUrl) homepageMobileScore = m.performanceScore
      if (m.performanceScore < 50) {
        lowScorePages.push({ url: p.url, score: m.performanceScore })
      }
    }
    if (typeof m.lcpMs === "number" && m.lcpMs > 2500) {
      poorLcpPages.push({ url: p.url, lcpMs: m.lcpMs })
    }
    if (typeof m.cls === "number" && m.cls > 0.1) {
      poorClsPages.push({ url: p.url, cls: m.cls })
    }
  }

  const averageMobileScore =
    scoreCount > 0 ? Math.round(scoreSum / scoreCount) : null

  // Sort each list by severity for readable downstream output.
  lowScorePages.sort((a, b) => a.score - b.score)
  poorLcpPages.sort((a, b) => b.lcpMs - a.lcpMs)
  poorClsPages.sort((a, b) => b.cls - a.cls)

  return {
    averageMobileScore,
    homepageMobileScore,
    lowScorePages,
    poorLcpPages,
    poorClsPages,
  }
}

/**
 * Run the PageSpeed pass over the prospect's homepage and top GSC pages.
 *
 * Mobile + desktop for each URL. Mobile is what Google ranks on; desktop is
 * captured for context. The whole pass is opt-in on `PAGESPEED_API_KEY` —
 * with no key the function returns a skipped report so callers can render
 * a "PageSpeed not configured" badge instead of erroring.
 */
export async function runPageSpeedAudit(opts: {
  domain: string
  topGscPages: string[]
}): Promise<PageSpeedReport> {
  const apiKey = env.PAGESPEED_API_KEY
  const { homepageUrl, urls } = selectPageSpeedUrls(opts)

  if (!apiKey) {
    return {
      homepageIncluded: urls.includes(homepageUrl),
      homepageUrl,
      pages: [],
      aggregates: {
        averageMobileScore: null,
        homepageMobileScore: null,
        lowScorePages: [],
        poorLcpPages: [],
        poorClsPages: [],
      },
      skippedCount: urls.length,
      skippedReason:
        "PAGESPEED_API_KEY is not set; performance pass skipped. Add the key in Vercel → Settings → Environment Variables.",
    }
  }

  const startedAt = Date.now()
  const pages: PageSpeedUrlResult[] = await Promise.all(
    urls.map(async (url) => {
      const [mobile, desktop] = await Promise.all([
        fetchOne(url, "mobile", apiKey),
        fetchOne(url, "desktop", apiKey),
      ])
      const result: PageSpeedUrlResult = { url, mobile, desktop }
      if (!mobile && !desktop) {
        result.error = "PageSpeed Insights returned no data for either strategy."
      }
      return result
    }),
  )

  const aggregates = buildAggregates(pages, homepageUrl)
  const report: PageSpeedReport = {
    homepageIncluded: urls.includes(homepageUrl),
    homepageUrl,
    pages,
    aggregates,
    skippedCount: 0,
  }

  console.log(
    `[pagespeed] domain=${opts.domain} urls=${urls.length} duration=${Math.round((Date.now() - startedAt) / 100) / 10}s avg_mobile=${aggregates.averageMobileScore ?? "n/a"} home_mobile=${aggregates.homepageMobileScore ?? "n/a"} low=${aggregates.lowScorePages.length} poor_lcp=${aggregates.poorLcpPages.length} poor_cls=${aggregates.poorClsPages.length}`,
  )
  return report
}

/**
 * True when the Performance synthesis section should be emitted by Claude
 * (any audited page has mobile performance score < 70).
 */
export function shouldEmitPerformanceSection(report: PageSpeedReport): boolean {
  for (const p of report.pages) {
    const score = p.mobile?.performanceScore
    if (typeof score === "number" && score < 70) return true
  }
  return false
}

/**
 * True when the Tier 1 executive-summary rule fires: homepage mobile
 * performance score is below 50.
 */
export function isHomepageTier1(report: PageSpeedReport): boolean {
  const s = report.aggregates.homepageMobileScore
  return typeof s === "number" && s < 50
}
