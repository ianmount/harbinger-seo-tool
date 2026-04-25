import "server-only"
import { BetaAnalyticsDataClient } from "@google-analytics/data"
import { google } from "googleapis"
import {
  GoogleAuthError,
  type GoogleAccount,
  emailFor,
  getGoogleAuthClient,
} from "@/lib/google-auth"
import type {
  GA4ChannelRow,
  GA4LandingPage,
  GA4MonthlyOrganicRow,
  GA4PageConversion,
  GA4PropertyInfo,
  GA4SeoReport,
  GA4TrafficSource,
} from "@/lib/types"

/**
 * GA4 client. All entry points take an explicit `account: GoogleAccount`
 * so the call site is responsible for picking the partners or assessments
 * Google identity (see lib/google-auth.ts for the factory).
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
  readonly account: GoogleAccount | undefined
  constructor(
    message: string,
    code: GA4ErrorCode,
    opts: { status?: number; account?: GoogleAccount } = {},
  ) {
    super(message)
    this.name = "GA4Error"
    this.code = code
    this.status = opts.status
    this.account = opts.account
  }
}

function getOAuth2(account: GoogleAccount) {
  try {
    return getGoogleAuthClient(account)
  } catch (err) {
    if (err instanceof GoogleAuthError) {
      throw new GA4Error(
        `${err.message} (Google account: ${emailFor(account)})`,
        "NO_REFRESH_TOKEN",
        { account },
      )
    }
    throw err
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

const cachedDataClients: Partial<Record<GoogleAccount, BetaAnalyticsDataClient>> = {}

/**
 * Returns a BetaAnalyticsDataClient bound to the requested account's OAuth
 * client. Cached per-account per-process so each Vercel invocation only
 * mints one gRPC/gax channel per identity.
 */
function getDataClient(account: GoogleAccount): BetaAnalyticsDataClient {
  const cached = cachedDataClients[account]
  if (cached) return cached
  const authClient = getOAuth2(account)
  const client = new BetaAnalyticsDataClient({ authClient })
  cachedDataClients[account] = client
  return client
}

/**
 * Translate an error from the Data/Admin APIs into a GA4Error with a stable
 * code the callers can branch on.
 */
function wrapApiError(
  error: unknown,
  context: string,
  account: GoogleAccount,
): never {
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
  throw new GA4Error(`${context}: ${message}`, mapped, {
    status: httpStatus,
    account,
  })
}

function toNumber(v: string | null | undefined): number {
  if (!v) return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function safeRate(num: number, denom: number): number {
  return denom > 0 ? num / denom : 0
}

const PROPERTY_CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes
const propertyCache: Partial<
  Record<GoogleAccount, { at: number; properties: GA4PropertyInfo[] }>
> = {}

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
  params: { account: GoogleAccount; forceRefresh?: boolean },
): Promise<GA4PropertyInfo[]> {
  const { account } = params
  const cached = propertyCache[account]
  if (
    !params.forceRefresh &&
    cached &&
    Date.now() - cached.at < PROPERTY_CACHE_TTL_MS
  ) {
    return cached.properties
  }
  const auth = getOAuth2(account)
  const admin = google.analyticsadmin({ version: "v1beta", auth })
  try {
    const summaries: Array<{ property: string; displayName: string }> = []
    let pageToken: string | undefined
    do {
      const response = await admin.accountSummaries.list({
        pageSize: 200,
        pageToken,
      })
      const accounts = response.data.accountSummaries ?? []
      for (const accountSummary of accounts) {
        for (const p of accountSummary.propertySummaries ?? []) {
          if (!p.property || !p.displayName) continue
          summaries.push({
            property: p.property,
            displayName: p.displayName,
          })
        }
      }
      pageToken = response.data.nextPageToken ?? undefined
    } while (pageToken)

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

    propertyCache[account] = { at: Date.now(), properties }
    return properties
  } catch (error: unknown) {
    wrapApiError(error, "listProperties", account)
  }
}

export async function getSeoReport(params: {
  account: GoogleAccount
  propertyId: string
  startDate: string
  endDate: string
}): Promise<GA4SeoReport> {
  assertIsoDate(params.startDate, "startDate")
  assertIsoDate(params.endDate, "endDate")
  if (params.startDate > params.endDate) {
    throw new GA4Error(
      "startDate must be on or before endDate",
      "INVALID_DATE_RANGE",
    )
  }
  const property = normalizePropertyId(params.propertyId)
  const client = getDataClient(params.account)
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
          limit: 50,
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
          limit: 50,
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
    wrapApiError(error, "getSeoReport", params.account)
  }
}

export async function getMonthlyOrganic(params: {
  account: GoogleAccount
  propertyId: string
  startDate: string
  endDate: string
}): Promise<GA4MonthlyOrganicRow[]> {
  assertIsoDate(params.startDate, "startDate")
  assertIsoDate(params.endDate, "endDate")
  const property = normalizePropertyId(params.propertyId)
  const client = getDataClient(params.account)
  try {
    const [resp] = await client.runReport({
      property,
      dateRanges: [{ startDate: params.startDate, endDate: params.endDate }],
      dimensions: [{ name: "yearMonth" }],
      metrics: [
        { name: "sessions" },
        { name: "conversions" },
        { name: "userEngagementDuration" },
      ],
      dimensionFilter: {
        filter: {
          fieldName: "sessionDefaultChannelGroup",
          stringFilter: { matchType: "EXACT", value: "Organic Search" },
        },
      },
      orderBys: [{ dimension: { dimensionName: "yearMonth" } }],
      limit: 24,
    })
    const rows = resp.rows ?? []
    return rows.flatMap((row): GA4MonthlyOrganicRow[] => {
      const yearMonthRaw = row.dimensionValues?.[0]?.value
      if (!yearMonthRaw) return []
      const month =
        yearMonthRaw.length === 6
          ? `${yearMonthRaw.slice(0, 4)}-${yearMonthRaw.slice(4)}`
          : yearMonthRaw
      return [
        {
          month,
          sessions: toNumber(row.metricValues?.[0]?.value),
          conversions: toNumber(row.metricValues?.[1]?.value),
          engagementDurationSec: toNumber(row.metricValues?.[2]?.value),
        },
      ]
    })
  } catch (error: unknown) {
    wrapApiError(error, "getMonthlyOrganic", params.account)
  }
}

export async function getChannelBreakdown(params: {
  account: GoogleAccount
  propertyId: string
  startDate: string
  endDate: string
}): Promise<GA4ChannelRow[]> {
  assertIsoDate(params.startDate, "startDate")
  assertIsoDate(params.endDate, "endDate")
  const property = normalizePropertyId(params.propertyId)
  const client = getDataClient(params.account)
  try {
    const [resp] = await client.runReport({
      property,
      dateRanges: [{ startDate: params.startDate, endDate: params.endDate }],
      dimensions: [{ name: "sessionDefaultChannelGroup" }],
      metrics: [
        { name: "sessions" },
        { name: "totalUsers" },
        { name: "conversions" },
      ],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 25,
    })
    const rows = resp.rows ?? []
    return rows.flatMap((row): GA4ChannelRow[] => {
      const channel = row.dimensionValues?.[0]?.value
      if (!channel) return []
      return [
        {
          channel,
          sessions: toNumber(row.metricValues?.[0]?.value),
          users: toNumber(row.metricValues?.[1]?.value),
          conversions: toNumber(row.metricValues?.[2]?.value),
        },
      ]
    })
  } catch (error: unknown) {
    wrapApiError(error, "getChannelBreakdown", params.account)
  }
}

export async function getConversionsByPage(params: {
  account: GoogleAccount
  propertyId: string
  startDate: string
  endDate: string
}): Promise<GA4PageConversion[]> {
  assertIsoDate(params.startDate, "startDate")
  assertIsoDate(params.endDate, "endDate")
  if (params.startDate > params.endDate) {
    throw new GA4Error(
      "startDate must be on or before endDate",
      "INVALID_DATE_RANGE",
    )
  }
  const property = normalizePropertyId(params.propertyId)
  const client = getDataClient(params.account)

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
    wrapApiError(error, "getConversionsByPage", params.account)
  }
}
