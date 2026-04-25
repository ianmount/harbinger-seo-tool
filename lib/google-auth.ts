import "server-only"
import { google } from "googleapis"
import type { OAuth2Client } from "google-auth-library"
import { env, requireEnv } from "@/lib/env"

/**
 * Two-account Google OAuth factory.
 *
 * The tool authenticates with two separate Google accounts that share one
 * Google Cloud OAuth client (one client ID, one client secret) but each
 * have their own refresh token:
 *
 *   - "partners"     — drives the existing partner pipeline. Refresh token
 *                      lives in GOOGLE_REFRESH_TOKEN_PARTNERS.
 *   - "assessments"  — drives the Assessment workflow (Audit + Competitive
 *                      Analysis). Refresh token lives in
 *                      GOOGLE_REFRESH_TOKEN_ASSESSMENTS.
 *
 * Every GSC and GA4 call must pass an account explicitly so it's obvious at
 * the call site which Google identity is being used. There is exactly one
 * place in the codebase that reads either refresh token env var (this
 * file). Routes that need an authed Google client call
 * `getGoogleAuthClient(account)` and let the factory pick the token.
 */

export type GoogleAccount = "partners" | "assessments"

/**
 * OAuth scopes requested during the consent flow. analytics.readonly is
 * included so the same refresh token drives both the GA4 Data / Admin APIs
 * and GSC. Changing this list requires re-consenting — revoke the existing
 * grant at https://myaccount.google.com/permissions and re-run the OAuth
 * setup script so Google mints a new refresh token with the full scope set.
 */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/analytics.readonly",
] as const

export class GoogleAuthError extends Error {
  readonly account: GoogleAccount
  readonly code: "NO_REFRESH_TOKEN"
  constructor(account: GoogleAccount) {
    const envVar =
      account === "partners"
        ? "GOOGLE_REFRESH_TOKEN_PARTNERS"
        : "GOOGLE_REFRESH_TOKEN_ASSESSMENTS"
    super(
      `${envVar} is not set. Run the OAuth setup script (scripts/oauth-setup.js --label ${account}) and paste the refresh token into your environment.`,
    )
    this.name = "GoogleAuthError"
    this.account = account
    this.code = "NO_REFRESH_TOKEN"
  }
}

/** Account → refresh token env var. Single source of truth. */
function refreshTokenFor(account: GoogleAccount): string | undefined {
  return account === "partners"
    ? env.GOOGLE_REFRESH_TOKEN_PARTNERS
    : env.GOOGLE_REFRESH_TOKEN_ASSESSMENTS
}

/** Account email lookup for user-facing error messages. */
export function emailFor(account: GoogleAccount): string {
  if (account === "partners") {
    return env.GOOGLE_PARTNERS_EMAIL ?? "(partners account)"
  }
  return env.GOOGLE_ASSESSMENTS_EMAIL ?? "(assessments account)"
}

/**
 * VERCEL_PROJECT_PRODUCTION_URL is the *stable* production domain. We
 * prefer it over VERCEL_URL because VERCEL_URL is unique per-deployment
 * and wouldn't match what's configured in Google Cloud Console. On preview
 * deploys this still resolves to the production URL, which is fine because
 * refresh tokens live in env vars, not per-request state.
 */
export function getRedirectUri(): string {
  const prodHost = process.env.VERCEL_PROJECT_PRODUCTION_URL
  const base = prodHost ? `https://${prodHost}` : "http://localhost:3000"
  return `${base}/api/gsc/callback`
}

const cachedClients: Partial<Record<GoogleAccount, OAuth2Client>> = {}

/**
 * Return a configured OAuth2 client for the requested account. Cached
 * per-process per-account because the client is stateless beyond its
 * credentials.
 *
 * Throws GoogleAuthError if the requested account's refresh token isn't
 * set. Routes should catch this and surface a helpful message pointing to
 * the OAuth setup script.
 */
export function getGoogleAuthClient(account: GoogleAccount): OAuth2Client {
  const cached = cachedClients[account]
  if (cached) return cached
  const refreshToken = refreshTokenFor(account)
  if (!refreshToken) {
    throw new GoogleAuthError(account)
  }
  const clientId = requireEnv("GOOGLE_CLIENT_ID")
  const clientSecret = requireEnv("GOOGLE_CLIENT_SECRET")
  const redirectUri = getRedirectUri()

  const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri)
  client.setCredentials({ refresh_token: refreshToken })
  cachedClients[account] = client
  return client
}

/** True when the requested account has a refresh token configured. */
export function hasRefreshToken(account: GoogleAccount): boolean {
  return Boolean(refreshTokenFor(account))
}

/**
 * Build a *bare* OAuth2 client (no credentials attached) for the consent
 * flow. Used by the OAuth callback route to exchange an authorization code
 * for tokens — at consent time the user is acquiring a refresh token, so
 * none exists yet to load.
 */
export function buildConsentClient(): OAuth2Client {
  const clientId = requireEnv("GOOGLE_CLIENT_ID")
  const clientSecret = requireEnv("GOOGLE_CLIENT_SECRET")
  const redirectUri = getRedirectUri()
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri)
}

/** URL the browser should be redirected to for the consent flow. */
export function generateAuthUrl(): string {
  const client = buildConsentClient()
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [...GOOGLE_SCOPES],
  })
}

/** Exchange an authorization code for tokens. */
export async function exchangeCodeForTokens(code: string) {
  const client = buildConsentClient()
  const { tokens } = await client.getToken(code)
  return tokens
}
