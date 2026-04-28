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
import { classifyPageType, extractSchemaFromHtml } from "@/lib/schema-parse"

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
 * Cap on raw-HTML schema samples per audit. Each call costs one
 * `/v3/on_page/raw_html` request; 16 keeps the schema slice meaningful
 * without ballooning the per-audit DataForSEO bill.
 */
const SCHEMA_SAMPLE_CAP = 16
const SCHEMA_SAMPLE_CONCURRENCY = 5

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
  homepage: string | null
  serviceUrls: string[]
  locationUrls: string[]
  blogUrls: string[]
  unclassified: string[]
}

/**
 * Pick up to SCHEMA_SAMPLE_CAP URLs to extract JSON-LD from. Strategy:
 * homepage first, then up to 4 representatives from each of the
 * service / location / blog buckets. Falls back to unclassified URLs
 * only after the bucketed picks are exhausted.
 */
function pickSchemaSampleUrls(crawledUrls: string[]): string[] {
  const slots: SampleSlot = {
    homepage: null,
    serviceUrls: [],
    locationUrls: [],
    blogUrls: [],
    unclassified: [],
  }
  for (const url of crawledUrls) {
    const bucket = classifyPageType(url)
    if (bucket === "homepage" && !slots.homepage) {
      slots.homepage = url
    } else if (bucket === "service" && slots.serviceUrls.length < 4) {
      slots.serviceUrls.push(url)
    } else if (bucket === "location" && slots.locationUrls.length < 4) {
      slots.locationUrls.push(url)
    } else if (bucket === "blog" && slots.blogUrls.length < 4) {
      slots.blogUrls.push(url)
    } else if (bucket === null) {
      slots.unclassified.push(url)
    }
  }

  const ordered: string[] = []
  if (slots.homepage) ordered.push(slots.homepage)
  ordered.push(
    ...slots.serviceUrls,
    ...slots.locationUrls,
    ...slots.blogUrls,
  )
  for (const u of slots.unclassified) {
    if (ordered.length >= SCHEMA_SAMPLE_CAP) break
    ordered.push(u)
  }
  return ordered.slice(0, SCHEMA_SAMPLE_CAP)
}

async function fetchSchemaSamples(
  taskId: string,
  urls: string[],
): Promise<SchemaSample[]> {
  if (urls.length === 0) return []
  const out: SchemaSample[] = []
  for (
    let start = 0;
    start < urls.length;
    start += SCHEMA_SAMPLE_CONCURRENCY
  ) {
    const slice = urls.slice(start, start + SCHEMA_SAMPLE_CONCURRENCY)
    const results = await Promise.all(
      slice.map(async (url) => {
        try {
          const html = await fetchRawHtml(taskId, url)
          if (!html) return null
          const extracted = extractSchemaFromHtml(html)
          return {
            url,
            types: extracted.types,
            blocks: extracted.blocks,
          }
        } catch (err) {
          // Schema extraction is best-effort. A single failure should not
          // tank the audit — log + continue so the rest of the sample lands.
          console.warn(
            `[audit-crawl] raw_html failed for ${url}: ${err instanceof Error ? err.message : "unknown"}`,
          )
          return null
        }
      }),
    )
    for (const r of results) {
      if (r) out.push(r)
    }
  }
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

  const crawledFinalUrls = onPage.pages
    .filter((p) => p.statusCode >= 200 && p.statusCode < 300)
    .map((p) => p.finalUrl || p.url)
  const sampleUrls = pickSchemaSampleUrls(crawledFinalUrls)
  const schemaSamples = await fetchSchemaSamples(onPage.taskId, sampleUrls)
  console.log(
    `[audit-crawl] schema samples requested=${sampleUrls.length} collected=${schemaSamples.length}`,
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
