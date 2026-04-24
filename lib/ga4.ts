import "server-only"
import { BetaAnalyticsDataClient } from "@google-analytics/data"
import { google } from "googleapis"
import { env } from "@/lib/env"
import { getOAuth2Client } from "@/lib/gsc"
import type {
  GA4LandingPage,
  GA4PageConversion,
  GA4PropertyInfo,
  GA4SeoReport,
  GA4TrafficSource,
} from "@/lib/types"

/**
 * GA4 Data API scope. analytics.readonly also covers the Admin API's read
 * endpoints (accountSummaries.list, etc.), so a single refresh token drives
 * both `getSeoReport` (Data) and `listProperties` (Admin). Scope is declared
 * on the shared OAuth client in lib/gsc.ts.
 */
export const GA4_SCOPES = [
  "https://www.googleapis.com/auth/analytics.readonly",
] as const

type GA4ErrorCode =
  | "NO_REFRESH_TOKEN"
  | "INVALID_PROPERTY_ID"
  | "INVALID_DATE_RANGE"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "API_ERROR"

export class GA4Error extends Error {
  readonly code: GA4ErrorCode
  readonly status: number | undefined
  constructor(message: string, code: GA4ErrorCode, status?: number) {
    super(message)
    this.name = "GA4Error"
    this.code = code
    this.status = status
  }
}

function assertRefreshToken(): void {
  if (!env.GOOGLE_REFRESH_TOKEN) {
    throw new GA4Error(
      "GOOGLE_REFRESH_TOKEN is not set. Complete the OAuth flow at /api/gsc/auth and set the refresh token in the environment.",
      "NO_REFRESH_TOKEN",
    )
  }
}

/**
 * Coerce whatever we got from Airtable ("123456789" or "properties/123456789")
 * into the canonical "properties/123456789" form that the Data and Admin APIs
 * expect.
 */
export function normalizePropertyId(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new GA4Error("Property ID is empty", "INVALID_PROPERTY_ID")
  }
  if (trimmed.startsWith("properties/")) {
    const suffix = trimmed.slice("properties/".length)
    if (!/^\d+$/.test(suffix)) {
      throw new GA4Error(
        `Invalid GA4 property ID: "${raw}" (expected numeric ID after "properties/")`,
        "INVALID_PROPERTY_ID",
      )
    }
    return trimmed
  }
  if (!/^\d+$/.test(trimmed)) {
    throw new GA4Error(
      `Invalid GA4 property ID: "${raw}" (expected numeric ID or "properties/<ID>")`,
      "INVALID_PROPERTY_ID",
    )
  }
  return `properties/${trimmed}`
}

const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/
function assertIsoDate(d: string, label: string): void {
  if (!isoDateRegex.test(d)) {
    throw new GA4Error(
      `${label} must be ISO YYYY-MM-DD (got "${d}")`,
      "INVALID_DATE_RANGE",
    )
  }
}

let cachedDataClient: BetaAnalyticsDataClient | null = null

/**
 * Returns a shared BetaAnalyticsDataClient bound to the same OAuth2 client
 * GSC uses. Cached per-process so each Vercel invocation only mints one
 * gRPC/gax channel.
 */
function getDataClient(): BetaAnalyticsDataClient {
  if (cachedDataClient) return cachedDataClient
  assertRefreshToken()
  const authClient = getOAuth2Client()
  cachedDataClient = new BetaAnalyticsDataClient({ authClient })
  return cachedDataClient
}

/**
 * Translate an error from the Data/Admin APIs into a GA4Error with a stable
 * code the callers can branch on.
 */
function wrapApiError(error: unknown, context: string): never {
  if (error instanceof GA4Error) throw error
  const err = error as {
    code?: number | string
    status?: number | string
    message?: string
  }
  // gRPC status codes we care about: 7 = PERMISSION_DENIED, 5 = NOT_FOUND,
  // 3 = INVALID_ARGUMENT. googleapis (Admin API via REST) uses HTTP status.
  const grpcOrHttp =
    typeof err?.code === "number"
      ? err.code
      : typeof err?.status === "number"
        ? err.status
        : undefined
  let mapped: GA4ErrorCode = "API_ERROR"
  let httpStatus: number | undefined
  if (grpcOrHttp === 7 || grpcOrHttp === 403) {
    mapped = "FORBIDDEN"
    httpStatus = 403
  } else if (grpcOrHttp === 5 || grpcOrHttp === 404) {
    mapped = "NOT_FOUND"
    httpStatus = 404
  } else if (grpcOrHttp === 3 || grpcOrHttp === 400) {
    mapped = "INVALID_PROPERTY_ID"
    httpStatus = 400
  } else if (typeof grpcOrHttp === "number") {
    httpStatus = grpcOrHttp
  }
  const message = error instanceof Error ? error.message : String(error)
  throw new GA4Error(`${context}: ${message}`, mapped, httpStatus)
}

function toNumber(v: string | null | undefined): number {
  if (!v) return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function safeRate(num: number, denom: number): number {
  return denom > 0 ? num / denom : 0
}

/**
 * Enumerate GA4 properties the authed account can see via the Admin API,
 * with each property's primary web-stream URL attached when available.
 *
 * Implemented as a two-step walk: first `accountSummaries.list` for the
 * property list, then `properties.dataStreams.list` per property to resolve
 * the website URL. The per-property call is the expensive part (N+1 pattern
 * at roughly one call per property), so we:
 *   - cap concurrency to 10 so we don't hammer Admin API quotas
 *   - cache the full result at module scope for the life of the serverless
 *     instance (`PROPERTY_CACHE_TTL_MS`). The cache is per-process on Vercel
 *     so cold starts re-fetch, which is fine — worst case one slow request.
 *
 * Pass `{ forceRefresh: true }` to bypass the cache (e.g. after a partner
 * reports a new property they just created).
 *
 * Requires analytics.readonly scope — covers both Admin read and Data. If
 * the token lacks admin access this throws GA4Error with code=FORBIDDEN;
 * callers can then fall back to Airtable's `GA4 Property ID` field.
 *
 * Streams whose `type !== "WEB_DATA_STREAM"` are ignored (mobile app
 * streams have no SEO-relevant URL). When a property has multiple web
 * streams we keep the first one returned — the SDK lists them in creation
 * order, so the oldest / primary stream wins.
 */
const PROPERTY_CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes
let propertyCache: { at: number; properties: GA4PropertyInfo[] } | null = null

async function mapWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results: U[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}

export async function listProperties(
  opts: { forceRefresh?: boolean } = {},
): Promise<GA4PropertyInfo[]> {
  if (
    !opts.forceRefresh &&
    propertyCache &&
    Date.now() - propertyCache.at < PROPERTY_CACHE_TTL_MS
  ) {
    return propertyCache.properties
  }
  assertRefreshToken()
  const auth = getOAuth2Client()
  const admin = google.analyticsadmin({ version: "v1beta", auth })
  try {
    // Step 1: enumerate properties via accountSummaries (handles paging).
    const summaries: Array<{ property: string; displayName: string }> = []
    let pageToken: string | undefined
    do {
      const response = await admin.accountSummaries.list({
        pageSize: 200,
        pageToken,
      })
      const accounts = response.data.accountSummaries ?? []
      for (const account of accounts) {
        for (const p of account.propertySummaries ?? []) {
          if (!p.property || !p.displayName) continue
          summaries.push({
            property: p.property,
            displayName: p.displayName,
          })
        }
      }
      pageToken = response.data.nextPageToken ?? undefined
    } while (pageToken)

    // Step 2: fetch data streams for each property, concurrency-limited.
    // A stream failure for one property shouldn't tank the whole list — we
    // just leave websiteUrl undefined for that property and let the caller
    // decide what to do (manual override).
    const properties = await mapWithConcurrency(summaries, 10, async (p) => {
      let websiteUrl: string | undefined
      try {
        const streamsResp = await admin.properties.dataStreams.list({
          parent: p.property,
          pageSize: 50,
        })
        const webStream = (streamsResp.data.dataStreams ?? []).find(
          (s) => s.type === "WEB_DATA_STREAM" && s.webStreamData?.defaultUri,
        )
        websiteUrl = webStream?.webStreamData?.defaultUri ?? undefined
      } catch (streamErr) {
        console.warn(
          `[ga4] dataStreams.list failed for ${p.property}; continuing without websiteUrl:`,
          streamErr instanceof Error ? streamErr.message : streamErr,
        )
      }
      return {
        propertyId: p.property,
        displayName: p.displayName,
        websiteUrl,
      }
    })

    propertyCache = { at: Date.now(), properties }
    return properties
  } catch (error: unknown) {
    wrapApiError(error, "listProperties")
  }
}

export async function getSeoReport(params: {
  propertyId: string
  startDate: string
  endDate: string
}): Promise<GA4SeoReport> {
  assertRefreshToken()
  assertIsoDate(params.startDate, "startDate")
  assertIsoDate(params.endDate, "endDate")
  if (params.startDate > params.endDate) {
    throw new GA4Error(
      "startDate must be on or before endDate",
      "INVALID_DATE_RANGE",
    )
  }
  const property = normalizePropertyId(params.propertyId)
  const client = getDataClient()
  const dateRanges = [
    { startDate: params.startDate, endDate: params.endDate },
  ] as const

  try {
    const [totalsResp, landingResp, trafficResp, organicResp] =
      await Promise.all([
        client.runReport({
          property,
          dateRanges: [...dateRanges],
          metrics: [
            { name: "sessions" },
            { name: "totalUsers" },
            { name: "conversions" },
          ],
        }),
        client.runReport({
          property,
          dateRanges: [...dateRanges],
          dimensions: [{ name: "landingPage" }],
          metrics: [{ name: "sessions" }, { name: "conversions" }],
          orderBys: [
            { metric: { metricName: "sessions" }, desc: true },
          ],
          limit: 10,
        }),
        client.runReport({
          property,
          dateRanges: [...dateRanges],
          dimensions: [
            { name: "sessionSource" },
            { name: "sessionMedium" },
          ],
          metrics: [{ name: "sessions" }, { name: "conversions" }],
          orderBys: [
            { metric: { metricName: "sessions" }, desc: true },
          ],
          limit: 25,
        }),
        client.runReport({
          property,
          dateRanges: [...dateRanges],
          dimensions: [{ name: "landingPage" }],
          metrics: [{ name: "sessions" }, { name: "conversions" }],
          dimensionFilter: {
            filter: {
              fieldName: "sessionDefaultChannelGroup",
              stringFilter: { matchType: "EXACT", value: "Organic Search" },
            },
          },
          orderBys: [
            { metric: { metricName: "sessions" }, desc: true },
          ],
          limit: 10,
        }),
      ])

    const totalsRow = totalsResp[0].rows?.[0]
    const sessions = toNumber(totalsRow?.metricValues?.[0]?.value)
    const users = toNumber(totalsRow?.metricValues?.[1]?.value)
    const conversions = toNumber(totalsRow?.metricValues?.[2]?.value)

    const topLandingPages: GA4LandingPage[] = (landingResp[0].rows ?? []).map(
      (row) => {
        const landingPage = row.dimensionValues?.[0]?.value ?? ""
        const s = toNumber(row.metricValues?.[0]?.value)
        const c = toNumber(row.metricValues?.[1]?.value)
        return {
          landingPage,
          sessions: s,
          conversions: c,
          conversionRate: safeRate(c, s),
        }
      },
    )

    const trafficSources: GA4TrafficSource[] = (
      trafficResp[0].rows ?? []
    ).map((row) => ({
      source: row.dimensionValues?.[0]?.value ?? "",
      medium: row.dimensionValues?.[1]?.value ?? "",
      sessions: toNumber(row.metricValues?.[0]?.value),
      conversions: toNumber(row.metricValues?.[1]?.value),
    }))

    const organicOnly: GA4LandingPage[] = (organicResp[0].rows ?? []).map(
      (row) => {
        const landingPage = row.dimensionValues?.[0]?.value ?? ""
        const s = toNumber(row.metricValues?.[0]?.value)
        const c = toNumber(row.metricValues?.[1]?.value)
        return {
          landingPage,
          sessions: s,
          conversions: c,
          conversionRate: safeRate(c, s),
        }
      },
    )

    // A GA4 property with no configured conversion events returns zeros
    // across every query in the range. Detect that case so the UI can show a
    // "conversions not configured" note instead of implying zero performance.
    const conversionsConfigured =
      conversions > 0 ||
      topLandingPages.some((p) => p.conversions > 0) ||
      organicOnly.some((p) => p.conversions > 0) ||
      trafficSources.some((t) => t.conversions > 0)

    return {
      propertyId: property,
      dateRange: { startDate: params.startDate, endDate: params.endDate },
      sessions,
      users,
      conversions,
      conversionsConfigured,
      topLandingPages,
      trafficSources,
      organicOnly,
    }
  } catch (error: unknown) {
    wrapApiError(error, "getSeoReport")
  }
}

/**
 * Returns landing pages ranked by conversions. Intended for the keyword
 * scoring flow: pages that already convert well are signal that their topical
 * cluster is paying off, and Claude can nudge related keywords up in fit.
 * Pages with zero conversions are omitted so the array is empty when the
 * property has no configured conversion events.
 */
export async function getConversionsByPage(params: {
  propertyId: string
  startDate: string
  endDate: string
}): Promise<GA4PageConversion[]> {
  assertRefreshToken()
  assertIsoDate(params.startDate, "startDate")
  assertIsoDate(params.endDate, "endDate")
  if (params.startDate > params.endDate) {
    throw new GA4Error(
      "startDate must be on or before endDate",
      "INVALID_DATE_RANGE",
    )
  }
  const property = normalizePropertyId(params.propertyId)
  const client = getDataClient()

  try {
    const [resp] = await client.runReport({
      property,
      dateRanges: [{ startDate: params.startDate, endDate: params.endDate }],
      dimensions: [{ name: "landingPage" }],
      metrics: [{ name: "sessions" }, { name: "conversions" }],
      orderBys: [{ metric: { metricName: "conversions" }, desc: true }],
      limit: 100,
    })
    const rows = resp.rows ?? []
    const out: GA4PageConversion[] = []
    for (const row of rows) {
      const landingPage = row.dimensionValues?.[0]?.value ?? ""
      if (!landingPage) continue
      const sessions = toNumber(row.metricValues?.[0]?.value)
      const conversions = toNumber(row.metricValues?.[1]?.value)
      if (conversions <= 0) continue
      out.push({
        landingPage,
        conversions,
        conversionRate: safeRate(conversions, sessions),
      })
    }
    return out
  } catch (error: unknown) {
    wrapApiError(error, "getConversionsByPage")
  }
}
