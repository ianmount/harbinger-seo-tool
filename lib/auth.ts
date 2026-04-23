import "server-only"
import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { env } from "@/lib/env"

export const COOKIE_NAME = "harbinger_auth"
export const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30 // 30 days

// Paths the proxy lets through without a valid cookie.
export const PUBLIC_PATHS = [
  "/login",
  "/api/auth/login",
  "/api/auth/logout",
] as const

interface TokenPayload {
  iat: number
  exp: number
}

function base64urlEncode(buf: Buffer): string {
  return buf.toString("base64url")
}

function base64urlDecode(s: string): Buffer {
  return Buffer.from(s, "base64url")
}

/** Sign an HMAC-SHA256 session token. Format: `<base64url(payload)>.<base64url(hmac)>`. */
export function signToken(secret: string, ttlSeconds: number): string {
  const now = Math.floor(Date.now() / 1000)
  const payload: TokenPayload = { iat: now, exp: now + ttlSeconds }
  const payloadB64 = base64urlEncode(Buffer.from(JSON.stringify(payload)))
  const sig = createHmac("sha256", secret).update(payloadB64).digest()
  return `${payloadB64}.${base64urlEncode(sig)}`
}

/** Verify a token against the secret. Returns null if invalid or expired. */
export function verifyToken(
  secret: string,
  token: string | undefined,
): TokenPayload | null {
  if (!token) return null
  const dot = token.indexOf(".")
  if (dot <= 0 || dot === token.length - 1) return null
  const payloadB64 = token.slice(0, dot)
  const sigB64 = token.slice(dot + 1)

  const expected = createHmac("sha256", secret).update(payloadB64).digest()
  let received: Buffer
  try {
    received = base64urlDecode(sigB64)
  } catch {
    return null
  }
  if (expected.length !== received.length) return null
  if (!timingSafeEqual(expected, received)) return null

  let payload: unknown
  try {
    payload = JSON.parse(base64urlDecode(payloadB64).toString("utf8"))
  } catch {
    return null
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof (payload as TokenPayload).iat !== "number" ||
    typeof (payload as TokenPayload).exp !== "number"
  ) {
    return null
  }
  const { iat, exp } = payload as TokenPayload
  if (exp < Math.floor(Date.now() / 1000)) return null
  return { iat, exp }
}

/**
 * Constant-time password comparison. Hashes both sides to SHA-256 first so
 * the two Buffers fed to timingSafeEqual are always the same length — prevents
 * leaking the expected password's length via the fast-path check.
 */
export function passwordsMatch(expected: string, candidate: string): boolean {
  const a = createHash("sha256").update(expected, "utf8").digest()
  const b = createHash("sha256").update(candidate, "utf8").digest()
  return timingSafeEqual(a, b)
}

// ────────────────────────────────────────────────────────────────────────────
// In-memory per-IP rate limiter for failed logins.
//
// Caveat: Vercel serverless functions don't share memory across instances or
// cold starts, so this is best-effort only. A determined attacker could hit
// many instances to bypass it. Acceptable for a single-user internal tool;
// upgrade to a persistent store (Upstash, Redis) if the threat model changes.

const FAIL_WINDOW_MS = 10 * 60 * 1000
const FAIL_MAX_ATTEMPTS = 5

const failedAttempts = new Map<string, number[]>()

function prune(ip: string, nowMs: number): number[] {
  const arr = failedAttempts.get(ip) ?? []
  const cutoff = nowMs - FAIL_WINDOW_MS
  const kept = arr.filter((t) => t > cutoff)
  if (kept.length === 0) {
    failedAttempts.delete(ip)
  } else {
    failedAttempts.set(ip, kept)
  }
  return kept
}

/** Is this IP currently rate-limited for failed logins? */
export function isRateLimited(ip: string): boolean {
  return prune(ip, Date.now()).length >= FAIL_MAX_ATTEMPTS
}

/** Record a failed login attempt for an IP. */
export function recordFailedAttempt(ip: string): void {
  const now = Date.now()
  const kept = prune(ip, now)
  kept.push(now)
  failedAttempts.set(ip, kept)
}

/** Clear all failed attempts for an IP (call on successful login). */
export function clearFailedAttempts(ip: string): void {
  failedAttempts.delete(ip)
}

// ────────────────────────────────────────────────────────────────────────────

export function getClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim()
    if (first) return first
  }
  const real = request.headers.get("x-real-ip")
  return real?.trim() || "unknown"
}

/** Convenience: return the current APP_AUTH_SECRET or null if unset. */
export function getAuthSecret(): string | null {
  return env.APP_AUTH_SECRET ?? null
}

/** Convenience: return APP_PASSWORD or null if unset. */
export function getAppPassword(): string | null {
  return env.APP_PASSWORD ?? null
}
