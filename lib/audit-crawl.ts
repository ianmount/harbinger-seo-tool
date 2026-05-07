import "server-only"
import type { CrawlMode, CrawlResults } from "@/lib/types"
import { discoverSitemap } from "@/lib/sitemap"
import {
  fetchLinksGraph,
  fetchRawHtml,
  instantPageProbe,
  OnPageError,
  runOnPageCrawl,
} from "@/lib/dataforseo-onpage"
import {
  buildCrawlReportFromOnPage,
  type SchemaSample,
} from "@/lib/onpage-to-crawl"
import {
  classifyPageType,
  extractImageAltStats,
  extractSchemaFromHtml,
} from "@/lib/schema-parse"

/**
 * Public surface for the Audit tab's crawl. Replaces the legacy
 * cheerio-based `lib/crawler.ts`. Internally the crawl is delegated to
 * DataForSEO's On-Page API: their crawl infrastructure bypasses the
 * Cloudflare-class WAFs that were defeating native fetch (returning
 * stripped 200 challenge bodies in place of real HTML).
 *
 * Public surface preserved verbatim: every existing caller imports
 * `crawlSite` and `CrawlError` from this module, gets back the same
 * `CrawlResults` shape they got from the cheerio crawler, and feeds the
 * same downstream analyses (cannibalization, broken-link detection,
 * URL-structure conflicts, schema coverage) without modification.
 */

const SAMPLE_MAX_PAGES = 50
const FULL_MAX_PAGES_CEILING = 2_000

/**
 * Cap on raw-HTML schema samples per crawl. Each call costs one
 * `/v3/on_page/raw_html` request (~$0.0005). 50 buys meaningful
 * deployment-depth signal — for a 12-page service section the matrix
 * can now report "Service deployed on 3 of 12 service pages" instead
 * of the binary "exists somewhere" view that masked partial deployment.
 */
const SCHEMA_SAMPLE_CAP = 50
const SCHEMA_SAMPLE_CONCURRENCY = 5
/** Per-bucket cap inside SCHEMA_SAMPLE_CAP. ~12 each + homepage + tail. */
const SCHEMA_SAMPLE_PER_BUCKET = 12

export class CrawlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CrawlError"
  }
}

export interface CrawlOptions {
  /** Max pages to fetch. Used by `sample` mode (capped at 50) or as a manual ceiling in `full` mode. */
  maxPages?: number
  /** Crawl mode. Defaults to `"full"`. Use `"sample"` for fast iteration. */
  mode?: CrawlMode
  /**
   * Legacy alias for `mode === "full"`. Retained because the Onboarding /
   * Initial Strategy workflow already passes `unlimited: true`.
   */
  unlimited?: boolean
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

interface SampleSlot {
  homepage: SampleCandidate | null
  serviceUrls: SampleCandidate[]
  locationUrls: SampleCandidate[]
  blogUrls: SampleCandidate[]
  unclassified: SampleCandidate[]
}

/**
 * A page from the crawl, with both the original `url` we asked DataForSEO
 * to crawl and the post-redirect `finalUrl`. The raw_html endpoint indexes
 * pages by the URL DFS originally crawled, which after redirects differs
 * from `finalUrl`. We carry both so `fetchSchemaSamples` can try the
 * primary URL and fall back to the alternate if DFS returns no HTML.
 */
interface SampleCandidate {
  primary: string
  alternate: string | null
}

/**
 * Pick up to SCHEMA_SAMPLE_CAP URLs to extract JSON-LD from. Strategy:
 * homepage first, then up to 4 representatives from each of the
 * service / location / blog buckets. Falls back to unclassified URLs
 * only after the bucketed picks are exhausted.
 */
function pickSchemaSampleUrls(
  crawledPages: { url: string; finalUrl: string }[],
): SampleCandidate[] {
  const slots: SampleSlot = {
    homepage: null,
    serviceUrls: [],
    locationUrls: [],
    blogUrls: [],
    unclassified: [],
  }
  for (const page of crawledPages) {
    const candidate: SampleCandidate = {
      primary: page.finalUrl || page.url,
      alternate:
        page.url && page.url !== (page.finalUrl || page.url) ? page.url : null,
    }
    const bucket = classifyPageType(candidate.primary)
    if (bucket === "homepage" && !slots.homepage) {
      slots.homepage = candidate
    } else if (
      bucket === "service" &&
      slots.serviceUrls.length < SCHEMA_SAMPLE_PER_BUCKET
    ) {
      slots.serviceUrls.push(candidate)
    } else if (
      bucket === "location" &&
      slots.locationUrls.length < SCHEMA_SAMPLE_PER_BUCKET
    ) {
      slots.locationUrls.push(candidate)
    } else if (
      bucket === "blog" &&
      slots.blogUrls.length < SCHEMA_SAMPLE_PER_BUCKET
    ) {
      slots.blogUrls.push(candidate)
    } else if (bucket === null) {
      slots.unclassified.push(candidate)
    }
  }

  const ordered: SampleCandidate[] = []
  if (slots.homepage) ordered.push(slots.homepage)
  ordered.push(
    ...slots.serviceUrls,
    ...slots.locationUrls,
    ...slots.blogUrls,
  )
  for (const c of slots.unclassified) {
    if (ordered.length >= SCHEMA_SAMPLE_CAP) break
    ordered.push(c)
  }
  return ordered.slice(0, SCHEMA_SAMPLE_CAP)
}

async function fetchSchemaSamples(
  taskId: string,
  candidates: SampleCandidate[],
): Promise<SchemaSample[]> {
  if (candidates.length === 0) return []
  const out: SchemaSample[] = []
  let nullHtmlCount = 0
  for (
    let start = 0;
    start < candidates.length;
    start += SCHEMA_SAMPLE_CONCURRENCY
  ) {
    const slice = candidates.slice(start, start + SCHEMA_SAMPLE_CONCURRENCY)
    const results = await Promise.all(
      slice.map(async (candidate) => {
        try {
          let html = await fetchRawHtml(taskId, candidate.primary)
          // After redirects, DFS sometimes only has the start URL keyed —
          // try the alternate before giving up.
          if (!html && candidate.alternate) {
            html = await fetchRawHtml(taskId, candidate.alternate)
          }
          if (!html) {
            nullHtmlCount += 1
            return null
          }
          const extracted = extractSchemaFromHtml(html)
          const altStats = extractImageAltStats(html)
          return {
            url: candidate.primary,
            types: extracted.types,
            blocks: extracted.blocks,
            imagesTotal: altStats.imagesTotal,
            imagesWithAlt: altStats.imagesWithAlt,
          }
        } catch (err) {
          // Schema extraction is best-effort. A single failure should not
          // tank the audit — log + continue so the rest of the sample lands.
          console.warn(
            `[audit-crawl] raw_html failed for ${candidate.primary}: ${err instanceof Error ? err.message : "unknown"}`,
          )
          return null
        }
      }),
    )
    for (const r of results) {
      if (r) out.push(r)
    }
  }
  if (nullHtmlCount > 0) {
    console.log(
      `[audit-crawl] raw_html returned no html for ${nullHtmlCount}/${candidates.length} sampled urls`,
    )
  }
  const totalTypes = out.reduce((s, x) => s + x.types.length, 0)
  console.log(
    `[audit-crawl] schema extraction parsed=${out.length} pages json_ld_types=${totalTypes}`,
  )
  return out
}

export async function crawlSite(params: {
  domain: string
  options?: CrawlOptions
  /**
   * Optional progress callback fired once per DFS poll. The streaming
   * gather route uses it to surface live "Crawling site — pages=142"
   * labels in the audit UI.
   */
  onProgress?: (progress: {
    pagesCrawled: number
    pagesInQueue: number
    status: string
  }) => void
}): Promise<CrawlResults> {
  const startedAt = Date.now()
  const domain = normalizeDomain(params.domain)
  const origin = originFor(domain)

  const opts = params.options ?? {}
  const requestedMode: CrawlMode | undefined = opts.mode
  const legacyUnlimited = opts.unlimited === true
  // legacyUnlimited maps onto "full" — same default as new code, but we
  // keep the alias because the Onboarding workflow still passes it.
  const mode: CrawlMode =
    requestedMode ?? (legacyUnlimited ? "full" : "full")

  const maxPages =
    mode === "sample"
      ? Math.min(opts.maxPages ?? SAMPLE_MAX_PAGES, SAMPLE_MAX_PAGES)
      : Math.min(opts.maxPages ?? FULL_MAX_PAGES_CEILING, FULL_MAX_PAGES_CEILING)

  console.log(
    `[audit-crawl] start domain=${domain} mode=${mode} max_pages=${maxPages}`,
  )

  // Sitemap discovery happens in parallel with the JS-rendering probe; both
  // are cheap and independent of one another.
  const sitemapPromise = discoverSitemap(domain)
  const probePromise = instantPageProbe(`${origin}/`, false).catch((err) => {
    console.warn(
      `[audit-crawl] instant_pages probe failed: ${err instanceof Error ? err.message : "unknown"}`,
    )
    return null
  })

  const [sitemap, probe] = await Promise.all([sitemapPromise, probePromise])
  console.log(
    `[audit-crawl] sitemap urls=${sitemap.sitemapUrls.length} crawl_delay=${sitemap.crawlDelaySec}s`,
  )

  // JS-rendering decision. If the static probe returns both head fields,
  // assume static HTML is sufficient and skip the JS-render surcharge.
  // Otherwise enable JS for the full crawl. If the probe itself failed
  // we conservatively run with JS off — DataForSEO will still produce a
  // crawl, the data may be thinner, and the missing-meta finding will
  // surface the underlying problem.
  let enableJavaScript = false
  if (probe && (!probe.hasTitle || !probe.hasDescription)) {
    enableJavaScript = true
    console.log(
      `[audit-crawl] probe missing head fields (title=${probe.hasTitle} desc=${probe.hasDescription}) — enabling JS rendering`,
    )
  } else if (probe) {
    console.log(
      `[audit-crawl] probe head ok — running static crawl (no JS rendering)`,
    )
  }

  let onPage: Awaited<ReturnType<typeof runOnPageCrawl>>
  try {
    onPage = await runOnPageCrawl({
      domain,
      maxPages,
      enableJavaScript,
      onProgress: params.onProgress,
    })
  } catch (err) {
    if (err instanceof OnPageError) {
      throw new CrawlError(`On-Page crawl failed: ${err.message}`)
    }
    throw err
  }
  console.log(
    `[audit-crawl] on-page finished task=${onPage.taskId} pages=${onPage.pages.length} duration=${onPage.durationMs}ms`,
  )

  let linkGraph: Map<string, string[]> = new Map()
  try {
    linkGraph = await fetchLinksGraph(onPage.taskId)
  } catch (err) {
    console.warn(
      `[audit-crawl] link graph fetch failed: ${err instanceof Error ? err.message : "unknown"} — broken-link detection will be a no-op`,
    )
  }
  console.log(
    `[audit-crawl] link graph sources=${linkGraph.size}`,
  )

  const okCrawledPages = onPage.pages
    .filter((p) => p.statusCode >= 200 && p.statusCode < 300)
    .map((p) => ({ url: p.url, finalUrl: p.finalUrl || p.url }))
  const sampleCandidates = pickSchemaSampleUrls(okCrawledPages)
  const schemaSamples = await fetchSchemaSamples(
    onPage.taskId,
    sampleCandidates,
  )
  console.log(
    `[audit-crawl] schema samples requested=${sampleCandidates.length} collected=${schemaSamples.length}`,
  )

  const report = await buildCrawlReportFromOnPage({
    domain,
    mode,
    onPage,
    linkGraph,
    sitemap,
    schemaSamples,
    maxPages,
  })

  // The on-page crawl's wall-clock is a subset of the audit's; re-stamp
  // crawlDurationMs with the full pipeline duration so the PDF footer's
  // "audit ran in X minutes" number is honest.
  report.crawlDurationMs = Date.now() - startedAt

  console.log(
    `[audit-crawl] domain=${domain} mode=${mode} done in ${report.crawlDurationMs}ms, ${report.pages.length - report.nonOkPages.length}/${report.pages.length} ok, ${report.nonOkPages.length} errors`,
  )

  return report
}
