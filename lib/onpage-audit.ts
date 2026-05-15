import "server-only"
import type { LighthouseCwv, OnPagePageRow } from "@/lib/dataforseo-onpage"

// ─────────────────────────────────────────────────────────────────────────────
// Check registry — weighted-severity rubric for the OnPage SEO Checker.
//
// Each check declares:
//   - `kind`: "page" (counted across applicable pages) or "site" (binary)
//   - `severity`: Error | Warning | Notice (drives the bucket the issue
//     surfaces in and the icon used in the UI)
//   - `weight`: deduction applied to site health in the spec formula
//   - `category`: which "Issues by category" bucket the check rolls up into
//   - `applies(page)`: returns true when this check is relevant for the page
//     (used as the denominator in the page-level health contribution)
//   - `fails(page, ctx)`: returns true when the page fails the check
//
// For site-level checks both `applies` and `fails` operate on the aggregate
// `AuditContext` instead of a per-page row.
// ─────────────────────────────────────────────────────────────────────────────

export type Severity = "error" | "warning" | "notice"

export type Category =
  | "Crawlability"
  | "HTTPS"
  | "Indexation"
  | "On-page SEO"
  | "Performance"
  | "Schema"
  | "Internal linking"

export interface PageCtx {
  page: OnPagePageRow
  brokenInternalTargetsByPage: Map<string, number>
  brokenExternalTargetsByPage: Map<string, number>
  mixedContentPages: Set<string>
  duplicateTitlePages: Set<string>
  duplicateContentPages: Set<string>
  duplicateDescPages: Set<string>
  redirectChainPages: Set<string>
  nonIndexablePages: Set<string>
  orphanPages: Set<string>
  schemaMissingServicePages: Set<string>
  isServicePage: (url: string) => boolean
  isFaqPage: (url: string) => boolean
  hasFaqSchema: (url: string) => boolean
  hasBreadcrumb: (url: string) => boolean
}

export interface SiteCtx {
  hostname: string
  isHttps: boolean
  robotsBlocksImportantPages: boolean
  sitemapMissing: boolean
  sslInvalid: boolean
  hasLocalBusinessOnHomepage: boolean
  compressionDisabled: boolean
}

export interface CheckDef {
  id: string
  label: string
  category: Category
  severity: Severity
  weight: number
  kind: "page" | "site"
  applies?: (p: PageCtx) => boolean
  fails?: (p: PageCtx) => boolean
  siteApplies?: (s: SiteCtx) => boolean
  siteFails?: (s: SiteCtx) => boolean
  /** Plain-language explanation surfaced under the issue title. */
  rationale: string
}

const PAGE_ALWAYS = () => true

export const CHECKS: CheckDef[] = [
  // ── Crawlability + status codes ──
  {
    id: "status_5xx",
    label: "Pages return 5xx status codes",
    category: "Crawlability",
    severity: "error",
    weight: 8,
    kind: "page",
    applies: PAGE_ALWAYS,
    fails: (p) => p.page.statusCode >= 500 && p.page.statusCode < 600,
    rationale:
      "Server-side failure — page returns 500/502/503; blocks indexing.",
  },
  {
    id: "status_4xx",
    label: "Pages return 4xx status codes",
    category: "Crawlability",
    severity: "error",
    weight: 6,
    kind: "page",
    applies: PAGE_ALWAYS,
    fails: (p) => p.page.statusCode >= 400 && p.page.statusCode < 500,
    rationale: "404s on pages that should exist break crawl efficiency.",
  },
  {
    id: "broken_internal_links",
    label: "Broken internal links",
    category: "Internal linking",
    severity: "error",
    weight: 5,
    kind: "page",
    applies: PAGE_ALWAYS,
    fails: (p) => (p.brokenInternalTargetsByPage.get(p.page.url) ?? 0) > 0,
    rationale: "Pages link to URLs that 404/410 — reachable from the site.",
  },
  {
    id: "robots_blocks_important",
    label: "robots.txt blocks important pages",
    category: "Crawlability",
    severity: "error",
    weight: 7,
    kind: "site",
    siteApplies: () => true,
    siteFails: (s) => s.robotsBlocksImportantPages,
    rationale: "robots.txt rules prevent crawlers from reaching key URLs.",
  },
  {
    id: "sitemap_missing",
    label: "Sitemap missing or unreachable",
    category: "Crawlability",
    severity: "error",
    weight: 4,
    kind: "site",
    siteApplies: () => true,
    siteFails: (s) => s.sitemapMissing,
    rationale: "Crawlers fall back to link discovery without a sitemap.",
  },
  {
    id: "meta_refresh",
    label: "Has meta refresh redirect",
    category: "Crawlability",
    severity: "warning",
    weight: 2,
    kind: "page",
    applies: PAGE_ALWAYS,
    fails: (p) => p.page.checks["has_meta_refresh_redirect"] === true,
    rationale: "Use a 301 redirect instead — meta refresh confuses crawlers.",
  },
  {
    id: "broken_external_links",
    label: "Broken external links",
    category: "Internal linking",
    severity: "warning",
    weight: 1.5,
    kind: "page",
    applies: PAGE_ALWAYS,
    fails: (p) => (p.brokenExternalTargetsByPage.get(p.page.url) ?? 0) > 0,
    rationale: "Outbound links pointing at dead pages erode trust signals.",
  },

  // ── HTTPS + security ──
  {
    id: "site_not_https",
    label: "Site not on HTTPS",
    category: "HTTPS",
    severity: "error",
    weight: 8,
    kind: "site",
    siteApplies: () => true,
    siteFails: (s) => !s.isHttps,
    rationale: "HTTPS is table stakes for ranking; sites on HTTP are penalized.",
  },
  {
    id: "ssl_invalid",
    label: "SSL certificate invalid or expired",
    category: "HTTPS",
    severity: "error",
    weight: 8,
    kind: "site",
    siteApplies: () => true,
    siteFails: (s) => s.sslInvalid,
    rationale: "Browsers show a security warning — visitors bounce.",
  },
  {
    id: "mixed_content",
    label: "Mixed content (HTTPS page loads HTTP resources)",
    category: "HTTPS",
    severity: "error",
    weight: 5,
    kind: "page",
    applies: PAGE_ALWAYS,
    fails: (p) =>
      p.page.checks["https_to_http_links"] === true ||
      p.mixedContentPages.has(p.page.url),
    rationale: "HTTPS pages loading HTTP resources block in modern browsers.",
  },

  // ── Indexation ──
  {
    id: "missing_canonical",
    label: "Missing canonical tag",
    category: "Indexation",
    severity: "error",
    weight: 5,
    kind: "page",
    applies: PAGE_ALWAYS,
    fails: (p) => !p.page.canonical,
    rationale: "Duplicate-content risk — Google picks the canonical on its own.",
  },
  {
    id: "canonical_to_redirect",
    label: "Canonical points to a redirect",
    category: "Indexation",
    severity: "error",
    weight: 5,
    kind: "page",
    applies: (p) => !!p.page.canonical,
    fails: (p) => p.page.checks["canonical_to_redirect"] === true,
    rationale: "Wastes the canonical signal — point to the final URL directly.",
  },
  {
    id: "canonical_chain",
    label: "Canonical chain (canonical → canonical)",
    category: "Indexation",
    severity: "warning",
    weight: 2,
    kind: "page",
    applies: (p) => !!p.page.canonical,
    fails: (p) => p.page.checks["canonical_chain"] === true,
    rationale: "Canonical chains dilute the signal; collapse to one hop.",
  },
  {
    id: "recursive_canonical",
    label: "Recursive canonical",
    category: "Indexation",
    severity: "warning",
    weight: 2,
    kind: "page",
    applies: (p) => !!p.page.canonical,
    fails: (p) => p.page.checks["recursive_canonical"] === true,
    rationale: "Canonical points back to a loop — crawlers ignore it.",
  },
  {
    id: "duplicate_title",
    label: "Duplicate title across pages",
    category: "Indexation",
    severity: "error",
    weight: 5,
    kind: "page",
    applies: (p) => !!p.page.title,
    fails: (p) => p.duplicateTitlePages.has(p.page.url),
    rationale: "Same title across pages — Google can't tell them apart.",
  },
  {
    id: "duplicate_content",
    label: "Duplicate content (substantial overlap)",
    category: "Indexation",
    severity: "error",
    weight: 6,
    kind: "page",
    applies: PAGE_ALWAYS,
    fails: (p) => p.duplicateContentPages.has(p.page.url),
    rationale: "Substantial body-text overlap with another crawled page.",
  },
  {
    id: "duplicate_description",
    label: "Duplicate meta description",
    category: "Indexation",
    severity: "warning",
    weight: 2,
    kind: "page",
    applies: (p) => !!p.page.description,
    fails: (p) => p.duplicateDescPages.has(p.page.url),
    rationale: "Same meta description across pages — weaker SERP snippets.",
  },
  {
    id: "non_indexable",
    label: "Non-indexable / noindex on important page",
    category: "Indexation",
    severity: "warning",
    weight: 3,
    kind: "page",
    applies: PAGE_ALWAYS,
    fails: (p) => p.nonIndexablePages.has(p.page.url),
    rationale: "Often intentional — confirm it shouldn't be indexed.",
  },
  {
    id: "orphan_page",
    label: "Orphan page (no internal links in)",
    category: "Internal linking",
    severity: "warning",
    weight: 1.5,
    kind: "page",
    applies: PAGE_ALWAYS,
    fails: (p) => p.orphanPages.has(p.page.url),
    rationale: "No internal links point here — crawlers find it only via sitemap.",
  },

  // ── On-page SEO basics ──
  {
    id: "missing_title",
    label: "Missing title tag",
    category: "On-page SEO",
    severity: "error",
    weight: 5,
    kind: "page",
    applies: PAGE_ALWAYS,
    fails: (p) => !p.page.title,
    rationale: "Title tag is the strongest on-page ranking signal.",
  },
  {
    id: "missing_h1",
    label: "Missing H1",
    category: "On-page SEO",
    severity: "error",
    weight: 4,
    kind: "page",
    applies: PAGE_ALWAYS,
    fails: (p) => p.page.h1s.length === 0,
    rationale: "H1 anchors the page topic for crawlers and assistive tech.",
  },
  {
    id: "multiple_h1",
    label: "Multiple H1 tags",
    category: "On-page SEO",
    severity: "warning",
    weight: 2,
    kind: "page",
    applies: PAGE_ALWAYS,
    fails: (p) => p.page.h1s.length > 1,
    rationale: "Pick one — multiple H1s split the topical signal.",
  },
  {
    id: "missing_meta_description",
    label: "Missing meta descriptions",
    category: "On-page SEO",
    severity: "warning",
    weight: 2,
    kind: "page",
    applies: PAGE_ALWAYS,
    fails: (p) => !p.page.description,
    rationale: "Weak SERP snippets — Google auto-generates one from the body.",
  },
  {
    id: "missing_viewport",
    label: "Missing viewport meta tag",
    category: "On-page SEO",
    severity: "warning",
    weight: 3,
    kind: "page",
    applies: PAGE_ALWAYS,
    fails: (p) => p.page.checks["no_viewport_tag"] === true,
    rationale: "Mobile-critical — pages without viewport render at desktop width.",
  },
  {
    id: "low_content_rate",
    label: "Low content rate (<300 words on indexable page)",
    category: "On-page SEO",
    severity: "warning",
    weight: 2.5,
    kind: "page",
    applies: (p) => !p.nonIndexablePages.has(p.page.url),
    fails: (p) => p.page.wordCount > 0 && p.page.wordCount < 300,
    rationale: "Thin-content signal — bulk up the page or noindex it.",
  },
  {
    id: "low_text_html_ratio",
    label: "Low text-to-HTML ratio",
    category: "On-page SEO",
    severity: "warning",
    weight: 1.5,
    kind: "page",
    applies: PAGE_ALWAYS,
    fails: (p) =>
      p.page.checks["low_content_rate"] === true ||
      p.page.checks["small_page_size"] === true,
    rationale: "Page is mostly markup — thin content signal.",
  },
  {
    id: "missing_image_alt",
    label: "Missing image alt text",
    category: "On-page SEO",
    severity: "warning",
    weight: 1.5,
    kind: "page",
    applies: (p) => p.page.imagesTotal > 0,
    fails: (p) =>
      p.page.imagesTotal > 0 &&
      p.page.imagesWithAlt < p.page.imagesTotal,
    rationale: "Image SEO + a11y — alt text describes the image to crawlers.",
  },
  {
    id: "title_length",
    label: "Title length outside 30-60 chars",
    category: "On-page SEO",
    severity: "notice",
    weight: 0.5,
    kind: "page",
    applies: (p) => !!p.page.title,
    fails: (p) => {
      const len = p.page.title?.length ?? 0
      return len < 30 || len > 60
    },
    rationale: "CTR risk in SERP — titles get truncated past ~60 chars.",
  },
  {
    id: "description_length",
    label: "Description length outside 70-160 chars",
    category: "On-page SEO",
    severity: "notice",
    weight: 0.3,
    kind: "page",
    applies: (p) => !!p.page.description,
    fails: (p) => {
      const len = p.page.description?.length ?? 0
      return len < 70 || len > 160
    },
    rationale: "SERP snippet truncates past ~160 chars.",
  },
  {
    id: "low_readability",
    label: "Low readability rate",
    category: "On-page SEO",
    severity: "notice",
    weight: 0.3,
    kind: "page",
    applies: PAGE_ALWAYS,
    fails: (p) => p.page.checks["low_readability_rate"] === true,
    rationale: "DFSEO's readability metric — noisy but worth a sanity check.",
  },
  {
    id: "deprecated_html",
    label: "Deprecated HTML tags",
    category: "On-page SEO",
    severity: "notice",
    weight: 0.3,
    kind: "page",
    applies: PAGE_ALWAYS,
    fails: (p) => p.page.checks["deprecated_html_tags"] === true,
    rationale: "Markup hasn't been touched since 2010 — clean it up.",
  },

  // ── Performance + CWV ──
  {
    id: "page_size_3mb",
    label: "Page size > 3MB",
    category: "Performance",
    severity: "warning",
    weight: 1,
    kind: "page",
    applies: PAGE_ALWAYS,
    fails: (p) =>
      p.page.checks["size_greater_than_3mb"] === true ||
      p.page.totalSizeBytes > 3_000_000,
    rationale: "Big pages take longer to load — costs CWV and crawl budget.",
  },
  {
    id: "compression_disabled",
    label: "Compression disabled",
    category: "Performance",
    severity: "warning",
    weight: 1,
    kind: "page",
    applies: PAGE_ALWAYS,
    fails: (p) => p.page.checks["no_content_encoding"] === true,
    rationale: "Gzip/Brotli not enabled — pages ship uncompressed bytes.",
  },
  {
    id: "render_blocking",
    label: "Has render-blocking resources",
    category: "Performance",
    severity: "warning",
    weight: 1.5,
    kind: "page",
    applies: PAGE_ALWAYS,
    fails: (p) => p.page.checks["has_render_blocking_resources"] === true,
    rationale: "JS/CSS blocks the initial render — defer or inline above-fold.",
  },
  {
    id: "loading_time_5s",
    label: "High loading time (>5s)",
    category: "Performance",
    severity: "warning",
    weight: 2,
    kind: "page",
    applies: (p) => p.page.loadTimeMs > 0,
    fails: (p) => p.page.loadTimeMs > 5_000,
    rationale: "Loading past 5s — visitors and crawl-rate both suffer.",
  },

  // ── Schema markup ──
  {
    id: "missing_localbusiness",
    label: "Missing LocalBusiness schema on homepage",
    category: "Schema",
    severity: "error",
    weight: 5,
    kind: "site",
    siteApplies: () => true,
    siteFails: (s) => !s.hasLocalBusinessOnHomepage,
    rationale: "Critical for local SEO — LocalBusiness powers map pack signals.",
  },
  {
    id: "missing_service_schema",
    label: "Missing Service schema on service pages",
    category: "Schema",
    severity: "warning",
    weight: 2,
    kind: "page",
    applies: (p) => p.isServicePage(p.page.url),
    fails: (p) => p.schemaMissingServicePages.has(p.page.url),
    rationale: "Service schema unlocks rich results for service-based queries.",
  },
  {
    id: "missing_breadcrumb",
    label: "Missing BreadcrumbList schema",
    category: "Schema",
    severity: "notice",
    weight: 0.5,
    kind: "page",
    applies: PAGE_ALWAYS,
    fails: (p) => !p.hasBreadcrumb(p.page.url),
    rationale: "BreadcrumbList replaces the URL in the SERP — bigger snippet.",
  },
  {
    id: "missing_faq_schema",
    label: "Missing FAQPage schema on FAQ pages",
    category: "Schema",
    severity: "notice",
    weight: 0.3,
    kind: "page",
    applies: (p) => p.isFaqPage(p.page.url),
    fails: (p) => !p.hasFaqSchema(p.page.url),
    rationale: "FAQPage schema can earn an expanded SERP snippet.",
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// Output shape
// ─────────────────────────────────────────────────────────────────────────────

export type IssueSeverity = Severity

export interface AuditTotals {
  pagesCrawled: number
  errors: number
  warnings: number
  notices: number
  lastCrawlIso: string
}

export interface CategoryBucket {
  category: Category
  count: number
}

export interface TopIssue {
  id: string
  label: string
  category: Category
  severity: Severity
  rationale: string
  affectedPages: number
  sampleUrl: string | null
}

export interface PerUrlRow {
  url: string
  path: string
  statusCode: number
  issues: number
  title: string | null
  titleLen: number | null
  titleStatus: "ok" | "warn" | "missing"
  loadTimeMs: number | null
}

export interface CoreWebVitals {
  source: "homepage-lighthouse" | "page-timing-median"
  sourceUrl: string | null
  lcpMs: number | null
  inpMs: number | null
  cls: number | null
}

export interface SchemaRow {
  type: string
  status: "ok" | "partial" | "missing"
  foundOn: number
  expectedOn: number | null
}

export interface AuditReport {
  health: number
  totals: AuditTotals
  byCategory: CategoryBucket[]
  topIssues: TopIssue[]
  perUrl: PerUrlRow[]
  cwv: CoreWebVitals | null
  schema: SchemaRow[]
  hostname: string
  jsRendered: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function pathOf(url: string): string {
  try {
    return new URL(url).pathname || "/"
  } catch {
    return url
  }
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ""
  }
}

function median(nums: number[]): number | null {
  const cleaned = nums.filter((n) => Number.isFinite(n) && n > 0)
  if (cleaned.length === 0) return null
  const sorted = [...cleaned].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]
  return (sorted[mid - 1] + sorted[mid]) / 2
}

function titleStatus(len: number | null): "ok" | "warn" | "missing" {
  if (len == null || len === 0) return "missing"
  if (len < 30 || len > 60) return "warn"
  return "ok"
}

// ─────────────────────────────────────────────────────────────────────────────
// Auxiliary data extraction
// ─────────────────────────────────────────────────────────────────────────────

interface LinkItem {
  page_from?: string
  page_to?: string
  type?: string
  direction?: string
  is_broken?: boolean
  status_code?: number
}

interface DupItem {
  pages?: { url?: string }[]
  total_count?: number
  url?: string
}

interface NonIndexableItem {
  url?: string
  reason?: string
}

interface RedirectChainItem {
  url?: string
  page_url?: string
}

function buildBrokenLinkMaps(rawLinks: unknown[]): {
  internalBroken: Map<string, number>
  externalBroken: Map<string, number>
  mixedContent: Set<string>
  inboundCounts: Map<string, number>
} {
  const internalBroken = new Map<string, number>()
  const externalBroken = new Map<string, number>()
  const mixedContent = new Set<string>()
  const inboundCounts = new Map<string, number>()

  for (const raw of rawLinks) {
    const link = raw as LinkItem
    const from = link.page_from
    const to = link.page_to
    if (!from || !to) continue

    const isBroken =
      link.is_broken === true ||
      (typeof link.status_code === "number" &&
        link.status_code >= 400 &&
        link.status_code < 600)

    const isInternal =
      link.type === "internal" || link.direction === "internal"

    if (isInternal) {
      inboundCounts.set(to, (inboundCounts.get(to) ?? 0) + 1)
      if (isBroken) internalBroken.set(from, (internalBroken.get(from) ?? 0) + 1)
    } else if (isBroken) {
      externalBroken.set(from, (externalBroken.get(from) ?? 0) + 1)
    }

    if (from.startsWith("https://") && to.startsWith("http://")) {
      mixedContent.add(from)
    }
  }

  return { internalBroken, externalBroken, mixedContent, inboundCounts }
}

function buildDuplicateMap(rawDupes: unknown[]): Set<string> {
  const out = new Set<string>()
  for (const raw of rawDupes) {
    const dup = raw as DupItem
    const pages = dup.pages ?? []
    if (pages.length < 2) continue
    for (const p of pages) {
      if (p?.url) out.add(p.url)
    }
  }
  return out
}

function buildNonIndexable(rawNonIndexable: unknown[]): Set<string> {
  const out = new Set<string>()
  for (const raw of rawNonIndexable) {
    const item = raw as NonIndexableItem
    if (item.url) out.add(item.url)
  }
  return out
}

function buildRedirectChains(rawChains: unknown[]): Set<string> {
  const out = new Set<string>()
  for (const raw of rawChains) {
    const item = raw as RedirectChainItem
    const url = item.url ?? item.page_url
    if (url) out.add(url)
  }
  return out
}

interface SchemaIndex {
  /** type → set of URLs that declared a JSON-LD node of that type */
  byType: Map<string, Set<string>>
  /** URL → set of declared types on that page */
  byUrl: Map<string, Set<string>>
}

function buildSchemaIndex(rawMicrodata: unknown[]): SchemaIndex {
  const byType = new Map<string, Set<string>>()
  const byUrl = new Map<string, Set<string>>()

  const walk = (node: unknown, url: string) => {
    if (!node) return
    if (Array.isArray(node)) {
      for (const child of node) walk(child, url)
      return
    }
    if (typeof node !== "object") return
    const obj = node as Record<string, unknown>
    const rawType = obj["@type"] ?? obj["type"]
    const types = Array.isArray(rawType)
      ? rawType
      : typeof rawType === "string"
        ? [rawType]
        : []
    for (const t of types) {
      if (typeof t !== "string") continue
      const set = byType.get(t) ?? new Set<string>()
      set.add(url)
      byType.set(t, set)
      const urlSet = byUrl.get(url) ?? new Set<string>()
      urlSet.add(t)
      byUrl.set(url, urlSet)
    }
    for (const v of Object.values(obj)) {
      if (v && typeof v === "object") walk(v, url)
    }
  }

  for (const raw of rawMicrodata) {
    const item = raw as Record<string, unknown>
    const url = typeof item.url === "string" ? item.url : ""
    if (!url) continue
    // DataForSEO /microdata returns parsed JSON-LD/microdata items. The
    // most common shape is a nested object with a `@type` string. We walk
    // the whole row recursively so any nested schema type is captured.
    walk(item, url)
    // Some responses expose a flat `types: string[]` field.
    if (Array.isArray(item.types)) {
      for (const t of item.types) {
        if (typeof t !== "string") continue
        const set = byType.get(t) ?? new Set<string>()
        set.add(url)
        byType.set(t, set)
        const urlSet = byUrl.get(url) ?? new Set<string>()
        urlSet.add(t)
        byUrl.set(url, urlSet)
      }
    }
  }
  return { byType, byUrl }
}

function classifyServicePage(url: string): boolean {
  const p = pathOf(url).toLowerCase()
  if (p === "/" || p === "") return false
  if (/^\/(services?|treatments?)(\/|$)/.test(p)) return true
  if (/^\/(blog|news|article|articles|category|tag)(\/|$)/.test(p))
    return false
  if (/^\/(about|contact|privacy|terms|sitemap|search)(\/|$)/.test(p))
    return false
  if (p.split("/").filter(Boolean).length === 1) return true
  return false
}

function classifyFaqPage(url: string): boolean {
  return /\/faq(s)?(\/|$)/i.test(pathOf(url))
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entrypoint
// ─────────────────────────────────────────────────────────────────────────────

export interface BuildAuditInput {
  pages: OnPagePageRow[]
  rawLinks: unknown[]
  rawDupTitles: unknown[]
  rawDupDescs: unknown[]
  rawNonIndexable: unknown[]
  rawRedirectChains: unknown[]
  rawMicrodata: unknown[]
  summary: unknown
  /** Provided when robots.txt was inspected; defaults to false. */
  robotsBlocksImportantPages?: boolean
  /** True when sitemap.xml lookup failed during the crawl. */
  sitemapMissing?: boolean
  /** True when SSL handshake failed; default false (we got 2xx responses). */
  sslInvalid?: boolean
  /** True when /no resources reported `Content-Encoding`; rare. */
  compressionDisabled?: boolean
  lighthouse: LighthouseCwv | null
  jsRendered: boolean
}

export function buildAuditReport(input: BuildAuditInput): AuditReport {
  const { pages } = input
  const homepage = pages[0]
  const hostname =
    hostnameOf(homepage?.url ?? "") || hostnameOf(homepage?.finalUrl ?? "")

  const isHttps = (homepage?.finalUrl ?? homepage?.url ?? "").startsWith(
    "https://",
  )

  const {
    internalBroken,
    externalBroken,
    mixedContent,
    inboundCounts,
  } = buildBrokenLinkMaps(input.rawLinks)

  const duplicateTitlePages = buildDuplicateMap(input.rawDupTitles)
  const duplicateDescPages = buildDuplicateMap(input.rawDupDescs)
  // Duplicate-content detection uses the per-page check flag when DFSEO
  // surfaces one; we don't pull `/duplicate_content` separately.
  const duplicateContentPages = new Set<string>()
  for (const p of pages) {
    if (p.checks["duplicate_content"] === true) {
      duplicateContentPages.add(p.url)
    }
  }

  const nonIndexablePages = buildNonIndexable(input.rawNonIndexable)
  // Augment with per-page check signals (DFSEO sometimes flags
  // `is_non_indexable` on the page row without surfacing it in the
  // /non_indexable endpoint).
  for (const p of pages) {
    if (
      p.checks["noindex"] === true ||
      p.checks["is_non_indexable"] === true
    ) {
      nonIndexablePages.add(p.url)
    }
  }

  const redirectChainPages = buildRedirectChains(input.rawRedirectChains)

  const schemaIdx = buildSchemaIndex(input.rawMicrodata)
  const homepageUrl = homepage?.url ?? ""
  const hasLocalBusinessOnHomepage = !!schemaIdx.byUrl
    .get(homepageUrl)
    ?.has("LocalBusiness")

  const schemaMissingServicePages = new Set<string>()
  for (const p of pages) {
    if (!classifyServicePage(p.url)) continue
    const types = schemaIdx.byUrl.get(p.url)
    if (!types || !types.has("Service")) {
      schemaMissingServicePages.add(p.url)
    }
  }

  // Orphan-page detection — every URL the crawler returned but no internal
  // link pointed at. Homepage is excluded; it's the seed.
  const orphanPages = new Set<string>()
  for (const p of pages) {
    if (p.url === homepageUrl) continue
    const inbound = inboundCounts.get(p.url) ?? 0
    if (inbound === 0) orphanPages.add(p.url)
  }

  const siteCtx: SiteCtx = {
    hostname,
    isHttps,
    robotsBlocksImportantPages: input.robotsBlocksImportantPages ?? false,
    sitemapMissing: input.sitemapMissing ?? false,
    sslInvalid: input.sslInvalid ?? false,
    hasLocalBusinessOnHomepage,
    compressionDisabled: input.compressionDisabled ?? false,
  }

  // Run every check against every page (or once for site checks) and tally
  // failing pages + a sample URL.
  type CheckResult = {
    def: CheckDef
    failingPages: string[]
    applicablePages: number
    siteFailed: boolean
  }
  const results: CheckResult[] = []

  for (const def of CHECKS) {
    if (def.kind === "site") {
      const applies = def.siteApplies ? def.siteApplies(siteCtx) : true
      const failed = applies && (def.siteFails?.(siteCtx) ?? false)
      results.push({
        def,
        failingPages: [],
        applicablePages: applies ? 1 : 0,
        siteFailed: failed,
      })
      continue
    }

    let applicable = 0
    const failing: string[] = []
    for (const page of pages) {
      const ctx: PageCtx = {
        page,
        brokenInternalTargetsByPage: internalBroken,
        brokenExternalTargetsByPage: externalBroken,
        mixedContentPages: mixedContent,
        duplicateTitlePages,
        duplicateContentPages,
        duplicateDescPages,
        redirectChainPages,
        nonIndexablePages,
        orphanPages,
        schemaMissingServicePages,
        isServicePage: classifyServicePage,
        isFaqPage: classifyFaqPage,
        hasFaqSchema: (url) =>
          schemaIdx.byUrl.get(url)?.has("FAQPage") ?? false,
        hasBreadcrumb: (url) =>
          schemaIdx.byUrl.get(url)?.has("BreadcrumbList") ?? false,
      }
      if (def.applies?.(ctx) === false) continue
      applicable += 1
      if (def.fails?.(ctx)) failing.push(page.url)
    }
    results.push({
      def,
      failingPages: failing,
      applicablePages: applicable,
      siteFailed: false,
    })
  }

  // Health score per the spec formula.
  let deduction = 0
  for (const r of results) {
    if (r.def.kind === "site") {
      if (r.siteFailed) deduction += r.def.weight
    } else if (r.applicablePages > 0) {
      deduction +=
        r.def.weight * (r.failingPages.length / r.applicablePages)
    }
  }
  const health = Math.max(0, Math.round(100 - deduction))

  // Severity totals.
  let errors = 0
  let warnings = 0
  let notices = 0
  for (const r of results) {
    const failed = r.def.kind === "site" ? r.siteFailed : r.failingPages.length > 0
    if (!failed) continue
    if (r.def.severity === "error") errors += 1
    else if (r.def.severity === "warning") warnings += 1
    else notices += 1
  }

  // Category buckets.
  const categoryCounts = new Map<Category, number>()
  for (const r of results) {
    const failedCount =
      r.def.kind === "site"
        ? r.siteFailed
          ? 1
          : 0
        : r.failingPages.length
    if (failedCount === 0) continue
    categoryCounts.set(
      r.def.category,
      (categoryCounts.get(r.def.category) ?? 0) + failedCount,
    )
  }
  const byCategory: CategoryBucket[] = Array.from(categoryCounts.entries())
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count)

  // Top issues — severity first, then affected count.
  const sevWeight: Record<Severity, number> = {
    error: 3,
    warning: 2,
    notice: 1,
  }
  const topIssues: TopIssue[] = results
    .filter((r) =>
      r.def.kind === "site" ? r.siteFailed : r.failingPages.length > 0,
    )
    .map((r) => ({
      id: r.def.id,
      label: r.def.label,
      category: r.def.category,
      severity: r.def.severity,
      rationale: r.def.rationale,
      affectedPages:
        r.def.kind === "site" ? pages.length : r.failingPages.length,
      sampleUrl: r.failingPages[0] ?? null,
    }))
    .sort((a, b) => {
      const sevDiff = sevWeight[b.severity] - sevWeight[a.severity]
      if (sevDiff !== 0) return sevDiff
      return b.affectedPages - a.affectedPages
    })
    .slice(0, 12)

  // Per-URL issue counts — count failed page-level checks per page.
  const perUrlFailures = new Map<string, number>()
  for (const r of results) {
    if (r.def.kind !== "page") continue
    for (const url of r.failingPages) {
      perUrlFailures.set(url, (perUrlFailures.get(url) ?? 0) + 1)
    }
  }

  const perUrl: PerUrlRow[] = pages
    .map((p) => ({
      url: p.url,
      path: pathOf(p.url),
      statusCode: p.statusCode,
      issues: perUrlFailures.get(p.url) ?? 0,
      title: p.title,
      titleLen: p.title?.length ?? null,
      titleStatus: titleStatus(p.title?.length ?? null),
      loadTimeMs: p.loadTimeMs > 0 ? p.loadTimeMs : null,
    }))
    .sort((a, b) => b.issues - a.issues)

  // Core Web Vitals.
  let cwv: CoreWebVitals | null = null
  if (input.lighthouse) {
    cwv = {
      source: "homepage-lighthouse",
      sourceUrl: input.lighthouse.url,
      lcpMs: input.lighthouse.lcpMs,
      inpMs: input.lighthouse.inpMs,
      cls: input.lighthouse.cls,
    }
  } else {
    const medianLoad = median(pages.map((p) => p.loadTimeMs))
    if (medianLoad != null) {
      cwv = {
        source: "page-timing-median",
        sourceUrl: null,
        // Use median load time as a coarse stand-in for LCP when Lighthouse
        // isn't available. INP/CLS need Lighthouse and stay null.
        lcpMs: medianLoad,
        inpMs: null,
        cls: null,
      }
    }
  }

  // Schema validation summary — covers the five spec types.
  const totalPages = pages.length || 1
  const serviceUrlCount = pages.filter((p) =>
    classifyServicePage(p.url),
  ).length
  const faqUrlCount = pages.filter((p) => classifyFaqPage(p.url)).length

  const schema: SchemaRow[] = [
    schemaRow("LocalBusiness", schemaIdx, null),
    schemaRow("Service", schemaIdx, serviceUrlCount),
    schemaRow("FAQPage", schemaIdx, faqUrlCount),
    schemaRow("Article", schemaIdx, null),
    schemaRow("BreadcrumbList", schemaIdx, totalPages),
  ]

  const lastCrawlIso = new Date().toISOString()

  return {
    health,
    totals: {
      pagesCrawled: pages.length,
      errors,
      warnings,
      notices,
      lastCrawlIso,
    },
    byCategory,
    topIssues,
    perUrl,
    cwv,
    schema,
    hostname,
    jsRendered: input.jsRendered,
  }
}

function schemaRow(
  type: string,
  idx: SchemaIndex,
  expectedOn: number | null,
): SchemaRow {
  const foundOn = idx.byType.get(type)?.size ?? 0
  let status: "ok" | "partial" | "missing"
  if (foundOn === 0) status = "missing"
  else if (expectedOn != null && foundOn < expectedOn) status = "partial"
  else status = "ok"
  return { type, status, foundOn, expectedOn }
}
