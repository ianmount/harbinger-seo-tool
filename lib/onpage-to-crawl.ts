import "server-only"
import type {
  CrawledPage,
  CrawlMode,
  CrawlResults,
} from "@/lib/types"
import {
  buildSchemaCoverageMatrix,
  NON_MEANINGFUL_SCHEMA_TYPES,
} from "@/lib/schema-parse"
import type { OnPageCrawlResult, OnPagePageRow } from "@/lib/dataforseo-onpage"
import type { SitemapDiscovery } from "@/lib/sitemap"

/**
 * Adapter: turns a DataForSEO On-Page crawl + link-graph + sitemap discovery
 * + schema sample into the legacy `CrawlResults` shape so every downstream
 * analysis (cannibalization, broken-link detection, URL-structure conflicts,
 * schema coverage matrix, the audit synthesis prompt) keeps working
 * untouched.
 *
 * Schema is sample-based — we can only extract JSON-LD from pages whose
 * raw HTML we fetched separately via `/v3/on_page/raw_html`. Pages outside
 * the sample get `schemaTypes: []` / `schemaBlocks: []`. The coverage
 * matrix is therefore lossy in the long tail; the buckets it leans on
 * (homepage, service, location, blog) are deliberately the ones we sample
 * from.
 */

const RECOMMENDED_SCHEMA_TYPES = [
  "LocalBusiness",
  "Service",
  "Organization",
  "BreadcrumbList",
  "Review",
  "FAQPage",
] as const

const THIN_CONTENT_THRESHOLD = 300

export interface SchemaSample {
  url: string
  types: string[]
  blocks: unknown[]
}

interface BuildOpts {
  domain: string
  mode: CrawlMode
  onPage: OnPageCrawlResult
  linkGraph: Map<string, string[]>
  sitemap: SitemapDiscovery
  schemaSamples: SchemaSample[]
  /**
   * Max pages the crawl was allowed to fetch. Surfaced in the report so the
   * synthesis prompt can disclose whether the audit hit the ceiling.
   */
  maxPages: number
}

function rowToCrawledPage(
  row: OnPagePageRow,
  schemaByUrl: Map<string, SchemaSample>,
  linkGraph: Map<string, string[]>,
): CrawledPage {
  const finalUrl = row.finalUrl || row.url
  const schema = schemaByUrl.get(finalUrl) ?? schemaByUrl.get(row.url)

  const internalLinksOut =
    linkGraph.get(finalUrl) ?? linkGraph.get(row.url) ?? []

  // SPA-shell heuristic. The legacy crawler used cheerio + a body-text
  // length check + framework root selectors; with DataForSEO we no longer
  // see the rendered DOM, so word_count from On-Page (which counts
  // post-render plain text when JS rendering is enabled) is the closest
  // signal we have. Status 200 with zero words = something is wrong.
  const spaShellDetected =
    row.statusCode === 200 && row.wordCount === 0

  return {
    url: row.url,
    finalUrl,
    status: row.statusCode,
    redirected: row.redirectChain.length > 1,
    redirectChain: row.redirectChain.length > 0 ? row.redirectChain : [row.url],
    title: row.title,
    metaDescription: row.description,
    metaRobots: row.metaRobots,
    canonical: row.canonical,
    h1s: row.h1s,
    h2s: row.h2s,
    h3s: row.h3s,
    schemaTypes: schema?.types ?? [],
    schemaBlocks: schema?.blocks ?? [],
    imagesTotal: row.imagesTotal,
    imagesWithAlt: row.imagesWithAlt,
    internalLinksOut,
    wordCount: row.wordCount,
    loadTimeMs: row.loadTimeMs,
    spaShellDetected,
  }
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

export async function buildCrawlReportFromOnPage(
  opts: BuildOpts,
): Promise<CrawlResults> {
  // Preliminary value — `lib/audit-crawl.ts` re-stamps this with the full
  // pipeline duration after the adapter returns.
  const onPageDurationMs = opts.onPage.durationMs
  const schemaByUrl = new Map<string, SchemaSample>()
  for (const sample of opts.schemaSamples) {
    schemaByUrl.set(sample.url, sample)
  }

  const pages: CrawledPage[] = opts.onPage.pages.map((row) =>
    rowToCrawledPage(row, schemaByUrl, opts.linkGraph),
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

  const missingCanonicals = okPages
    .filter((p) => !p.canonical)
    .map((p) => p.finalUrl)
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

  // Sample-based caveat: with no JSON-LD scan on the long tail we can't
  // tell whether unsampled pages have meaningful schema. Count only the
  // sampled OK pages here; the synthesis prompt is told elsewhere that
  // schema findings are sample-based.
  const sampledUrls = new Set(opts.schemaSamples.map((s) => s.url))
  const pagesMissingMeaningfulSchema = okPages.filter((p) => {
    if (!sampledUrls.has(p.finalUrl) && !sampledUrls.has(p.url)) return false
    if (p.schemaTypes.length === 0) return true
    return p.schemaTypes.every((t) => NON_MEANINGFUL_SCHEMA_TYPES.has(t))
  }).length

  const schemaCoverageMatrix = buildSchemaCoverageMatrix(okPages)

  const totalImgs = okPages.reduce((s, p) => s + p.imagesTotal, 0)
  const totalImgsWithAlt = okPages.reduce((s, p) => s + p.imagesWithAlt, 0)
  const imageAltCoveragePercent = totalImgs
    ? Math.round((totalImgsWithAlt / totalImgs) * 100)
    : 100

  return {
    domain: opts.domain,
    mode: opts.mode,
    sitemapUrls: opts.sitemap.sitemapUrls,
    crawledCount: pages.length,
    maxPages: opts.maxPages,
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
    schemaTypesRecommended: [...schemaTypesRecommended],
    imageAltCoveragePercent,
    crawlDurationMs: onPageDurationMs,
    statusCodeDistribution,
    pagesMissingMeaningfulSchema,
    schemaCoverageMatrix,
    crawlDelaySec: opts.sitemap.crawlDelaySec,
  }
}
