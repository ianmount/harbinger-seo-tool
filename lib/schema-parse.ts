import "server-only"
import * as cheerio from "cheerio"
import type {
  CrawledPage,
  SchemaCoverageMatrix,
  SchemaGapRecommendation,
  SchemaPageType,
  SchemaPageTypeBucket,
} from "@/lib/types"

/**
 * JSON-LD extraction + schema-coverage matrix logic.
 *
 * Lifted from the legacy cheerio-based crawler (`lib/crawler.ts`, removed
 * during the DataForSEO On-Page migration). The crawl proper now runs on
 * DataForSEO's infrastructure, but a raw-HTML sample of pages is still
 * fetched from the On-Page API so we can extract structured data — which
 * On-Page itself does not surface in `/v3/on_page/pages`.
 */

/**
 * Schema types that don't help a local business rank — they're auto-generated
 * by themes (logo image, blog post markup, author bio) and don't substitute
 * for LocalBusiness / Service / Review. Used to flag pages whose only
 * structured data is decorative.
 */
export const NON_MEANINGFUL_SCHEMA_TYPES = new Set([
  "Article",
  "BlogPosting",
  "NewsArticle",
  "WebPage",
  "WebSite",
  "Person",
  "ImageObject",
])

// ── Schema coverage matrix ─────────────────────────────────────────────────
//
// The matrix replaces the legacy binary "schema types present / recommended
// missing" view. Pages are classified by URL pattern (homepage / service /
// location / blog) and each bucket is checked against the schema types a
// local-service-business should be carrying.

/**
 * URL-pattern heuristics for service pages on a local-service-business site.
 * Matches both the canonical `/services/<slug>` pattern and the common
 * top-level service slugs sites use directly (e.g. `/remodeling/...`).
 */
export const SERVICE_PATH_PATTERNS: RegExp[] = [
  /\/services?\//i,
  /\/remodeling\//i,
  /\/repair\//i,
  /\/installation\//i,
  /\/replacement\//i,
  /\/maintenance\//i,
  /\/cleaning\//i,
  /\/plumbing\//i,
  /\/hvac\//i,
  /\/heating\//i,
  /\/cooling\//i,
  /\/air-conditioning\//i,
  /\/electrical\//i,
  /\/electrician\//i,
  /\/roofing\//i,
  /\/landscaping\//i,
  /\/painting\//i,
  /\/flooring\//i,
  /\/pest-control\//i,
  /\/lawn(?:-care)?\//i,
]

export const LOCATION_PATH_PATTERNS: RegExp[] = [
  /\/locations?\//i,
  /\/areas?-served\//i,
  /\/service-areas?\//i,
  /\/cities\//i,
  /\/neighborhoods?\//i,
]

export const BLOG_PATH_PATTERNS: RegExp[] = [
  /\/blog\//i,
  /\/news\//i,
  /\/articles?\//i,
  /\/posts?\//i,
  /\/insights?\//i,
  /\/\d{4}\/\d{2}\//,
]

/**
 * LocalBusiness subtypes that satisfy the "LocalBusiness on homepage /
 * location page" expectation. Pragmatic local-services subset; keyed by
 * exact `@type` string match.
 */
export const LOCAL_BUSINESS_TYPES = new Set([
  "LocalBusiness",
  "Plumber",
  "Electrician",
  "ElectricalContractor",
  "HVACBusiness",
  "RoofingContractor",
  "GeneralContractor",
  "HomeAndConstructionBusiness",
  "ProfessionalService",
  "AutoRepair",
  "AutoBodyShop",
  "Dentist",
  "MedicalBusiness",
  "MedicalClinic",
  "LegalService",
  "Attorney",
  "FinancialService",
  "RealEstateAgent",
  "Restaurant",
  "Store",
  "ChildCare",
  "DryCleaningOrLaundry",
  "MovingCompany",
  "PestControlBusiness",
  "HousePainter",
  "Locksmith",
])

/**
 * Article-equivalent types: BlogPosting/NewsArticle satisfy "Article" on a
 * blog-like page.
 */
export const ARTICLE_TYPES = new Set(["Article", "BlogPosting", "NewsArticle"])

/** Schema types expected per page-type bucket. */
export const EXPECTED_TYPES_BY_PAGE_TYPE: Record<SchemaPageType, string[]> = {
  homepage: ["Organization", "LocalBusiness", "WebSite"],
  service: ["Service", "BreadcrumbList"],
  location: ["LocalBusiness", "BreadcrumbList"],
  blog: ["Article", "BreadcrumbList"],
}

/**
 * Classify a crawled URL into one of four buckets. Returns null for URLs
 * that don't fit any pattern. Order matters: homepage check wins over
 * service / location / blog patterns (a site whose root is `/services/`
 * would otherwise be miscategorized).
 */
export function classifyPageType(url: string): SchemaPageType | null {
  let path: string
  try {
    path = new URL(url).pathname.toLowerCase()
  } catch {
    return null
  }
  if (path === "/" || path === "" || path === "/index.html") return "homepage"
  if (LOCATION_PATH_PATTERNS.some((re) => re.test(path))) return "location"
  if (BLOG_PATH_PATTERNS.some((re) => re.test(path))) return "blog"
  if (SERVICE_PATH_PATTERNS.some((re) => re.test(path))) return "service"
  return null
}

/**
 * For a given expected type and the set of types observed on a bucket,
 * decide whether the expectation is satisfied. Most types match exactly;
 * "LocalBusiness" additionally matches any LOCAL_BUSINESS_TYPES subtype,
 * "Article" matches any of BlogPosting/NewsArticle.
 */
export function expectationSatisfied(
  expected: string,
  found: Set<string>,
): boolean {
  if (found.has(expected)) return true
  if (expected === "LocalBusiness") {
    for (const t of found) if (LOCAL_BUSINESS_TYPES.has(t)) return true
  }
  if (expected === "Article") {
    for (const t of found) if (ARTICLE_TYPES.has(t)) return true
  }
  return false
}

export interface SchemaExtraction {
  /** Distinct @type values pulled from JSON-LD blocks on the page. */
  types: string[]
  /** Raw parsed JSON-LD objects, kept verbatim for downstream analysis. */
  blocks: unknown[]
}

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
export function extractSchemaFromHtml(html: string): SchemaExtraction {
  const $ = cheerio.load(html)
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

/**
 * Returns true when a page's schema set is "decorative-only" — every type is
 * one of NON_MEANINGFUL_SCHEMA_TYPES. Empty schema sets also count as
 * missing-meaningful-schema (the page has no structured data at all).
 */
export function isMissingMeaningfulSchema(schemaTypes: string[]): boolean {
  if (schemaTypes.length === 0) return true
  return schemaTypes.every((t) => NON_MEANINGFUL_SCHEMA_TYPES.has(t))
}

/**
 * Build the schema coverage matrix from the crawl's OK pages. Buckets are
 * always emitted (even when empty) so the synthesis prompt can render a
 * consistent table — an empty location bucket on a site without location
 * pages is itself meaningful evidence.
 *
 * `prioritizedRecommendations` orders gaps by SEO impact for a local
 * service business: LocalBusiness on homepage > Service on service pages >
 * BreadcrumbList sitewide > FAQPage on service pages.
 */
export function buildSchemaCoverageMatrix(
  pages: CrawledPage[],
): SchemaCoverageMatrix {
  const allTypes = new Set<string>()
  for (const p of pages) for (const t of p.schemaTypes) allTypes.add(t)

  const grouped: Record<SchemaPageType, CrawledPage[]> = {
    homepage: [],
    service: [],
    location: [],
    blog: [],
  }
  for (const page of pages) {
    const bucket = classifyPageType(page.finalUrl || page.url)
    if (bucket) grouped[bucket].push(page)
  }

  const buckets: SchemaPageTypeBucket[] = (
    ["homepage", "service", "location", "blog"] as SchemaPageType[]
  ).map((pageType) => {
    const pagesInBucket = grouped[pageType]
    const typesFoundSet = new Set<string>()
    let pagesWithNoSchema = 0
    for (const p of pagesInBucket) {
      if (p.schemaTypes.length === 0) pagesWithNoSchema++
      for (const t of p.schemaTypes) typesFoundSet.add(t)
    }
    const expected = EXPECTED_TYPES_BY_PAGE_TYPE[pageType]
    const missing = expected.filter(
      (e) => !expectationSatisfied(e, typesFoundSet),
    )
    return {
      pageType,
      pageCount: pagesInBucket.length,
      sampleUrls: pagesInBucket.slice(0, 5).map((p) => p.finalUrl || p.url),
      typesFound: [...typesFoundSet].sort(),
      typesExpected: expected,
      typesMissing: missing,
      pagesWithNoSchema,
    }
  })

  // Priority order is fixed per the audit spec: LocalBusiness on homepage,
  // then Service on service pages, then BreadcrumbList sitewide, then
  // FAQPage where applicable. A gap only goes on the list when the bucket
  // has at least one page (no point recommending Service on service pages
  // when no service pages were crawled).
  const recommendations: SchemaGapRecommendation[] = []
  const homepage = buckets.find((b) => b.pageType === "homepage")
  const service = buckets.find((b) => b.pageType === "service")
  const location = buckets.find((b) => b.pageType === "location")
  const blog = buckets.find((b) => b.pageType === "blog")

  if (
    homepage &&
    homepage.pageCount > 0 &&
    homepage.typesMissing.includes("LocalBusiness")
  ) {
    recommendations.push({
      pageType: "homepage",
      missingType: "LocalBusiness",
      priority: 1,
      pageCount: homepage.pageCount,
      sampleUrls: homepage.sampleUrls,
    })
  }
  if (
    service &&
    service.pageCount > 0 &&
    service.typesMissing.includes("Service")
  ) {
    recommendations.push({
      pageType: "service",
      missingType: "Service",
      priority: 2,
      pageCount: service.pageCount,
      sampleUrls: service.sampleUrls,
    })
  }
  for (const b of [service, location, blog, homepage]) {
    if (!b || b.pageCount === 0) continue
    if (!b.typesMissing.includes("BreadcrumbList")) continue
    recommendations.push({
      pageType: b.pageType,
      missingType: "BreadcrumbList",
      priority: 3,
      pageCount: b.pageCount,
      sampleUrls: b.sampleUrls,
    })
  }
  if (
    service &&
    service.pageCount > 0 &&
    !service.typesFound.includes("FAQPage")
  ) {
    recommendations.push({
      pageType: "service",
      missingType: "FAQPage",
      priority: 4,
      pageCount: service.pageCount,
      sampleUrls: service.sampleUrls,
    })
  }

  return {
    schemaTypesInUse: [...allTypes].sort(),
    buckets,
    prioritizedRecommendations: recommendations,
  }
}
