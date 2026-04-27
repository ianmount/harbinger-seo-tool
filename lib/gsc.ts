import "server-only"
import { google } from "googleapis"
import {
  GoogleAuthError,
  GOOGLE_SCOPES,
  type GoogleAccount,
  emailFor,
  exchangeCodeForTokens as authExchangeCodeForTokens,
  generateAuthUrl as authGenerateAuthUrl,
  getGoogleAuthClient,
  getRedirectUri,
} from "@/lib/google-auth"
import type {
  GSCDailyRow,
  GSCQueryRow,
  GSCSiteInfo,
  GSCTopPageRow,
  GSCTopQueryRow,
  IndexCoverageReport,
  InspectedUrl,
} from "@/lib/types"

/**
 * GSC client. All entry points take an explicit `account: GoogleAccount`
 * so it's obvious at the call site which Google identity is being used:
 *
 *   - "partners"     — existing partner pipeline (Reporting, Keyword
 *                      Research). Uses GOOGLE_REFRESH_TOKEN_PARTNERS.
 *   - "assessments"  — Assessment workflow (Audit + Comp Analysis). Uses
 *                      GOOGLE_REFRESH_TOKEN_ASSESSMENTS.
 *
 * The auth factory in `lib/google-auth.ts` is the only place that reads
 * either refresh token env var.
 */

// Re-export auth scopes / helpers for backwards compatibility with consumers
// that imported them from this module.
export { GOOGLE_SCOPES as GSC_SCOPES, getRedirectUri }
export const generateAuthUrl = authGenerateAuthUrl
export const exchangeCodeForTokens = authExchangeCodeForTokens

export class GSCError extends Error {
  readonly code: "NO_REFRESH_TOKEN" | "API_ERROR"
  readonly status: number | undefined
  readonly account: GoogleAccount | undefined
  constructor(
    message: string,
    code: "NO_REFRESH_TOKEN" | "API_ERROR",
    opts: { status?: number; account?: GoogleAccount } = {},
  ) {
    super(message)
    this.name = "GSCError"
    this.code = code
    this.status = opts.status
    this.account = opts.account
  }
}

/**
 * Normalize a freeform website URL into a GSC URL-prefix siteUrl.
 *
 * Ensures a protocol and a trailing slash. Domain-property GSC sites
 * ("sc-domain:example.com") would need a different derivation — only used
 * when the partner has a dedicated GSC field.
 */
export function partnerWebsiteToGscSiteUrl(website: string): string {
  let url = website.trim()
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`
  }
  if (!url.endsWith("/")) {
    url = `${url}/`
  }
  return url
}

function getOAuth2(account: GoogleAccount) {
  try {
    return getGoogleAuthClient(account)
  } catch (err) {
    if (err instanceof GoogleAuthError) {
      throw new GSCError(
        `${err.message} (Google account: ${emailFor(account)})`,
        "NO_REFRESH_TOKEN",
        { account },
      )
    }
    throw err
  }
}

function wrapApiError(error: unknown, account: GoogleAccount): never {
  if (error instanceof GSCError) throw error
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status: unknown }).status)
      : undefined
  const message = error instanceof Error ? error.message : "Unknown GSC error"
  throw new GSCError(message, "API_ERROR", {
    status: Number.isFinite(status) ? status : undefined,
    account,
  })
}

export async function listSites(
  account: GoogleAccount,
): Promise<GSCSiteInfo[]> {
  const auth = getOAuth2(account)
  const webmasters = google.webmasters({ version: "v3", auth })
  try {
    const response = await webmasters.sites.list()
    const entries = response.data.siteEntry ?? []
    return entries.flatMap((entry) => {
      if (!entry.siteUrl || !entry.permissionLevel) return []
      return [
        { siteUrl: entry.siteUrl, permissionLevel: entry.permissionLevel },
      ]
    })
  } catch (error: unknown) {
    wrapApiError(error, account)
  }
}

type RawRow = {
  keys?: string[] | null
  clicks?: number | null
  impressions?: number | null
  ctr?: number | null
  position?: number | null
}

function normalizeRow(row: RawRow) {
  return {
    clicks: row.clicks ?? 0,
    impressions: row.impressions ?? 0,
    ctr: row.ctr ?? 0,
    position: row.position ?? 0,
  }
}

export async function getQueries(params: {
  account: GoogleAccount
  siteUrl: string
  startDate: string
  endDate: string
  rowLimit?: number
}): Promise<GSCQueryRow[]> {
  const auth = getOAuth2(params.account)
  const webmasters = google.webmasters({ version: "v3", auth })
  try {
    const response = await webmasters.searchanalytics.query({
      siteUrl: params.siteUrl,
      requestBody: {
        startDate: params.startDate,
        endDate: params.endDate,
        dimensions: ["query", "page"],
        rowLimit: params.rowLimit ?? 1000,
      },
    })
    const rows = response.data.rows ?? []
    return rows.flatMap((row: RawRow) => {
      const keys = row.keys ?? []
      const query = keys[0]
      const page = keys[1]
      if (!query || !page) return []
      return [{ query, page, ...normalizeRow(row) }]
    })
  } catch (error: unknown) {
    wrapApiError(error, params.account)
  }
}

export async function getTopQueries(params: {
  account: GoogleAccount
  siteUrl: string
  startDate: string
  endDate: string
  rowLimit?: number
}): Promise<GSCTopQueryRow[]> {
  const auth = getOAuth2(params.account)
  const webmasters = google.webmasters({ version: "v3", auth })
  try {
    const response = await webmasters.searchanalytics.query({
      siteUrl: params.siteUrl,
      requestBody: {
        startDate: params.startDate,
        endDate: params.endDate,
        dimensions: ["query"],
        rowLimit: params.rowLimit ?? 100,
      },
    })
    const rows = response.data.rows ?? []
    return rows.flatMap((row: RawRow) => {
      const query = row.keys?.[0]
      if (!query) return []
      return [{ query, ...normalizeRow(row) }]
    })
  } catch (error: unknown) {
    wrapApiError(error, params.account)
  }
}

export async function getTopPages(params: {
  account: GoogleAccount
  siteUrl: string
  startDate: string
  endDate: string
  rowLimit?: number
}): Promise<GSCTopPageRow[]> {
  const auth = getOAuth2(params.account)
  const webmasters = google.webmasters({ version: "v3", auth })
  try {
    const response = await webmasters.searchanalytics.query({
      siteUrl: params.siteUrl,
      requestBody: {
        startDate: params.startDate,
        endDate: params.endDate,
        dimensions: ["page"],
        rowLimit: params.rowLimit ?? 100,
      },
    })
    const rows = response.data.rows ?? []
    return rows.flatMap((row: RawRow) => {
      const page = row.keys?.[0]
      if (!page) return []
      return [{ page, ...normalizeRow(row) }]
    })
  } catch (error: unknown) {
    wrapApiError(error, params.account)
  }
}

/**
 * Paginated wrapper for top-queries with [query] dimension. GSC's
 * `searchanalytics.query` caps each call at 25,000 rows; for the audit we
 * sometimes want the full long-tail (16-month rollup), so this helper
 * walks startRow until the API returns fewer than `pageSize` rows.
 *
 * `maxRows` caps total pulled rows so a runaway brand-with-millions-of-queries
 * site doesn't time out the function. Default 25,000 — one API call.
 */
export async function getTopQueriesPaginated(params: {
  account: GoogleAccount
  siteUrl: string
  startDate: string
  endDate: string
  pageSize?: number
  maxRows?: number
}): Promise<GSCTopQueryRow[]> {
  const auth = getOAuth2(params.account)
  const webmasters = google.webmasters({ version: "v3", auth })
  const pageSize = Math.min(params.pageSize ?? 25_000, 25_000)
  const maxRows = params.maxRows ?? 25_000
  const out: GSCTopQueryRow[] = []
  try {
    for (let startRow = 0; out.length < maxRows; startRow += pageSize) {
      const response = await webmasters.searchanalytics.query({
        siteUrl: params.siteUrl,
        requestBody: {
          startDate: params.startDate,
          endDate: params.endDate,
          dimensions: ["query"],
          rowLimit: pageSize,
          startRow,
        },
      })
      const rows = response.data.rows ?? []
      for (const row of rows) {
        const r = row as RawRow
        const query = r.keys?.[0]
        if (!query) continue
        out.push({ query, ...normalizeRow(r) })
        if (out.length >= maxRows) break
      }
      if (rows.length < pageSize) break
    }
    return out
  } catch (error: unknown) {
    wrapApiError(error, params.account)
  }
}

/** Same idea for [page] dimension — 16-month page-level rollup. */
export async function getTopPagesPaginated(params: {
  account: GoogleAccount
  siteUrl: string
  startDate: string
  endDate: string
  pageSize?: number
  maxRows?: number
}): Promise<GSCTopPageRow[]> {
  const auth = getOAuth2(params.account)
  const webmasters = google.webmasters({ version: "v3", auth })
  const pageSize = Math.min(params.pageSize ?? 25_000, 25_000)
  const maxRows = params.maxRows ?? 25_000
  const out: GSCTopPageRow[] = []
  try {
    for (let startRow = 0; out.length < maxRows; startRow += pageSize) {
      const response = await webmasters.searchanalytics.query({
        siteUrl: params.siteUrl,
        requestBody: {
          startDate: params.startDate,
          endDate: params.endDate,
          dimensions: ["page"],
          rowLimit: pageSize,
          startRow,
        },
      })
      const rows = response.data.rows ?? []
      for (const row of rows) {
        const r = row as RawRow
        const page = r.keys?.[0]
        if (!page) continue
        out.push({ page, ...normalizeRow(r) })
        if (out.length >= maxRows) break
      }
      if (rows.length < pageSize) break
    }
    return out
  } catch (error: unknown) {
    wrapApiError(error, params.account)
  }
}

export async function getDailyClicks(params: {
  account: GoogleAccount
  siteUrl: string
  startDate: string
  endDate: string
}): Promise<GSCDailyRow[]> {
  const auth = getOAuth2(params.account)
  const webmasters = google.webmasters({ version: "v3", auth })
  try {
    const response = await webmasters.searchanalytics.query({
      siteUrl: params.siteUrl,
      requestBody: {
        startDate: params.startDate,
        endDate: params.endDate,
        dimensions: ["date"],
      },
    })
    const rows = response.data.rows ?? []
    return rows.flatMap((row: RawRow) => {
      const date = row.keys?.[0]
      if (!date) return []
      return [{ date, ...normalizeRow(row) }]
    })
  } catch (error: unknown) {
    wrapApiError(error, params.account)
  }
}

/** Cap on URL Inspection calls per audit. The API quota is 2,000/day per
 *  property; 10 keeps audits well clear and matches the spec. */
const URL_INSPECTION_SAMPLE_SIZE = 10

/**
 * Normalize a URL for comparing sitemap entries against GSC search-analytics
 * page rows. Sitemap and GSC URLs frequently differ on cosmetics that don't
 * change the canonical resource:
 *
 *   - scheme/host casing
 *   - trailing slash on non-root paths
 *   - tracking query strings (utm_*, gclid, fbclid, etc.)
 *   - URL fragments
 *
 * We strip queries entirely because most local-business sitemaps list bare
 * canonical URLs while GSC may surface query-bearing variants. Returns null
 * when the input doesn't parse as an absolute URL.
 */
function normalizeUrlForIndexComparison(raw: string): string | null {
  try {
    const u = new URL(raw)
    u.hash = ""
    u.search = ""
    u.protocol = u.protocol.toLowerCase()
    u.hostname = u.hostname.toLowerCase()
    let pathname = u.pathname
    if (pathname.length > 1 && pathname.endsWith("/")) {
      pathname = pathname.slice(0, -1)
    }
    u.pathname = pathname
    return u.toString()
  } catch {
    return null
  }
}

/**
 * Compute an indexation-coverage proxy for a site by diffing the sitemap
 * against URLs that have appeared in GSC search analytics in the last 90
 * days, then confirming a sample of the missing set via the URL Inspection
 * API.
 *
 * Conceptual signature (per the spec): get_index_coverage(site_url,
 * sitemap_urls, gsc_data) — `gscData` is the 90-day page-level rollup the
 * caller has already fetched (so this function stays deterministic for a
 * given input set, and the caller controls the date window).
 *
 * Returns null only when an unrecoverable error short-circuits the pipeline
 * — sitemap=0 or gsc=0 still produce a valid (but noisy) report so callers
 * can surface the data gap.
 */
export async function getIndexCoverage(params: {
  account: GoogleAccount
  siteUrl: string
  sitemapUrls: string[]
  /** 90-day search-analytics page rollup. Only the `page` field is read. */
  gscPages: { page: string }[]
  dateRange: { startDate: string; endDate: string }
  /** Override sample size for tests; defaults to 10. */
  sampleSize?: number
}): Promise<IndexCoverageReport> {
  const sampleSize = params.sampleSize ?? URL_INSPECTION_SAMPLE_SIZE

  // Build the "seen by GSC" set (normalized).
  const indexedSet = new Set<string>()
  for (const row of params.gscPages) {
    const norm = normalizeUrlForIndexComparison(row.page)
    if (norm) indexedSet.add(norm)
  }

  // Walk the sitemap once: split into indexed / probably-not-indexed,
  // preserving the original (un-normalized) sitemap URL in the output so
  // PDF readers see the URL the way it was published.
  const indexedUrls: string[] = []
  const probablyNotIndexed: string[] = []
  const seenSitemap = new Set<string>()
  for (const raw of params.sitemapUrls) {
    const norm = normalizeUrlForIndexComparison(raw)
    if (!norm || seenSitemap.has(norm)) continue
    seenSitemap.add(norm)
    if (indexedSet.has(norm)) {
      indexedUrls.push(raw)
    } else {
      probablyNotIndexed.push(raw)
    }
  }

  // Inspect a sample of the probably-not-indexed set. URL Inspection is
  // serial here — the API rate-limits at 600 calls/min which is comfortable
  // for 10 requests, and serial keeps error attribution clean.
  const auth = getOAuth2(params.account)
  const searchconsole = google.searchconsole({ version: "v1", auth })
  const sample = probablyNotIndexed.slice(0, sampleSize)
  const inspectedSample: InspectedUrl[] = []
  for (const url of sample) {
    try {
      const response = await searchconsole.urlInspection.index.inspect({
        requestBody: {
          inspectionUrl: url,
          siteUrl: params.siteUrl,
        },
      })
      const status = response.data.inspectionResult?.indexStatusResult
      inspectedSample.push({
        url,
        coverageState: status?.coverageState ?? null,
        lastCrawlTime: status?.lastCrawlTime ?? null,
        pageFetchState: status?.pageFetchState ?? null,
        verdict: status?.verdict ?? null,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown inspection error"
      inspectedSample.push({
        url,
        coverageState: null,
        lastCrawlTime: null,
        pageFetchState: null,
        verdict: null,
        error: msg,
      })
    }
  }

  return {
    siteUrl: params.siteUrl,
    dateRange: params.dateRange,
    sitemapCount: params.sitemapUrls.length,
    indexedUrls,
    probablyNotIndexed,
    inspectedSample,
  }
}
