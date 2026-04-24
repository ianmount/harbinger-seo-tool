import "server-only"
import { google } from "googleapis"
import type { OAuth2Client } from "google-auth-library"
import { env, requireEnv } from "@/lib/env"
import type {
  GSCDailyRow,
  GSCQueryRow,
  GSCSiteInfo,
  GSCTopPageRow,
  GSCTopQueryRow,
} from "@/lib/types"

/**
 * OAuth scopes requested during the consent flow. analytics.readonly is
 * included so the same refresh token can also drive the GA4 Data / Admin APIs
 * (see lib/ga4.ts). Changing this list requires re-consenting — revoke the
 * existing grant at https://myaccount.google.com/permissions and re-run
 * /api/gsc/auth so Google mints a new refresh token with the full scope set.
 */
export const GSC_SCOPES = [
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/analytics.readonly",
] as const

export class GSCError extends Error {
  readonly code: "NO_REFRESH_TOKEN" | "API_ERROR"
  readonly status: number | undefined
  constructor(
    message: string,
    code: "NO_REFRESH_TOKEN" | "API_ERROR",
    status?: number,
  ) {
    super(message)
    this.name = "GSCError"
    this.code = code
    this.status = status
  }
}

/**
 * Build the OAuth redirect URI for the current environment.
 *
 * VERCEL_PROJECT_PRODUCTION_URL is the *stable* production domain (e.g.
 * "harbinger-seo-tool.vercel.app"). We prefer it over VERCEL_URL because
 * VERCEL_URL is unique per-deployment and wouldn't match what's configured
 * in Google Cloud Console. On preview deploys, this still resolves to the
 * production URL, which is fine because the refresh token lives in env vars,
 * not per-request state.
 */
/**
 * Normalize a partner's freeform website URL into a GSC URL-prefix siteUrl.
 *
 * Ensures a protocol and a trailing slash. Partners stored as domain
 * properties ("sc-domain:example.com") would need a different derivation —
 * we'll add that once Airtable has a dedicated GSC field.
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

export function getRedirectUri(): string {
  const prodHost = process.env.VERCEL_PROJECT_PRODUCTION_URL
  const base = prodHost ? `https://${prodHost}` : "http://localhost:3000"
  return `${base}/api/gsc/callback`
}

let cachedClient: OAuth2Client | null = null

/**
 * Return a configured OAuth2 client. If GOOGLE_REFRESH_TOKEN is set, the
 * client is pre-loaded with it so googleapis will auto-mint access tokens
 * on every call. Cached per-process because the client is stateless beyond
 * its credentials (fine for single-engineer MVP).
 */
export function getOAuth2Client(): OAuth2Client {
  if (cachedClient) return cachedClient
  const clientId = requireEnv("GOOGLE_CLIENT_ID")
  const clientSecret = requireEnv("GOOGLE_CLIENT_SECRET")
  const redirectUri = getRedirectUri()

  const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri)
  if (env.GOOGLE_REFRESH_TOKEN) {
    client.setCredentials({ refresh_token: env.GOOGLE_REFRESH_TOKEN })
  }
  cachedClient = client
  return client
}

/** URL the browser should be redirected to for the consent flow. */
export function generateAuthUrl(): string {
  const client = getOAuth2Client()
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [...GSC_SCOPES],
  })
}

/** Exchange an authorization code for tokens. */
export async function exchangeCodeForTokens(code: string) {
  const client = getOAuth2Client()
  const { tokens } = await client.getToken(code)
  return tokens
}

function assertRefreshToken(): void {
  if (!env.GOOGLE_REFRESH_TOKEN) {
    throw new GSCError(
      "GOOGLE_REFRESH_TOKEN is not set. Complete the OAuth flow at /api/gsc/auth and set the refresh token in the environment.",
      "NO_REFRESH_TOKEN",
    )
  }
}

function wrapApiError(error: unknown): never {
  if (error instanceof GSCError) throw error
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status: unknown }).status)
      : undefined
  const message = error instanceof Error ? error.message : "Unknown GSC error"
  throw new GSCError(message, "API_ERROR", Number.isFinite(status) ? status : undefined)
}

export async function listSites(): Promise<GSCSiteInfo[]> {
  assertRefreshToken()
  const auth = getOAuth2Client()
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
    wrapApiError(error)
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
  siteUrl: string
  startDate: string
  endDate: string
  rowLimit?: number
}): Promise<GSCQueryRow[]> {
  assertRefreshToken()
  const auth = getOAuth2Client()
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
    wrapApiError(error)
  }
}

export async function getTopQueries(params: {
  siteUrl: string
  startDate: string
  endDate: string
  rowLimit?: number
}): Promise<GSCTopQueryRow[]> {
  assertRefreshToken()
  const auth = getOAuth2Client()
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
    wrapApiError(error)
  }
}

export async function getTopPages(params: {
  siteUrl: string
  startDate: string
  endDate: string
  rowLimit?: number
}): Promise<GSCTopPageRow[]> {
  assertRefreshToken()
  const auth = getOAuth2Client()
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
    wrapApiError(error)
  }
}

export async function getDailyClicks(params: {
  siteUrl: string
  startDate: string
  endDate: string
}): Promise<GSCDailyRow[]> {
  assertRefreshToken()
  const auth = getOAuth2Client()
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
    wrapApiError(error)
  }
}
