import "server-only"
import { z } from "zod"

// Accept any string (including empty) and coerce blank-or-missing to undefined
// so the rest of the app can use truthy checks uniformly.
const optionalString = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().min(1).optional(),
)

const envSchema = z.object({
  ANTHROPIC_API_KEY: optionalString,
  DATAFORSEO_LOGIN: optionalString,
  DATAFORSEO_PASSWORD: optionalString,
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  // Two-account Google OAuth setup. The partners token drives the existing
  // partner pipeline (Reporting, Keyword Research, etc.); the assessments
  // token drives the Assessment workflow (Audit + Competitive Analysis).
  // Same OAuth client, different refresh tokens.
  GOOGLE_REFRESH_TOKEN_PARTNERS: optionalString,
  GOOGLE_REFRESH_TOKEN_ASSESSMENTS: optionalString,
  GOOGLE_PARTNERS_EMAIL: optionalString,
  GOOGLE_ASSESSMENTS_EMAIL: optionalString,
  AIRTABLE_PAT: optionalString,
  AIRTABLE_BASE_ID: optionalString,
  AIRTABLE_PARTNERS_TABLE: optionalString,
  APP_PASSWORD: optionalString,
  APP_AUTH_SECRET: optionalString,
  // Vercel Blob storage token for the SEO Audit PDF output. Required only
  // for the /audit tab — the rest of the app works without it.
  BLOB_READ_WRITE_TOKEN: optionalString,
  // Google PageSpeed Insights API key. Optional but recommended — without a
  // key the API rate-limits aggressively (a handful of calls per minute);
  // with a free key from Google Cloud Console you get 25,000/day. When
  // unset, the audit pipeline skips the PageSpeed pass with a warning.
  PAGESPEED_API_KEY: optionalString,
})

export type Env = z.infer<typeof envSchema>

const parsed = envSchema.safeParse(process.env)
if (!parsed.success) {
  throw new Error(
    "Env schema parse failed: " + JSON.stringify(parsed.error.flatten()),
  )
}

export const env: Env = parsed.data

const REQUIRED_KEYS = [
  "ANTHROPIC_API_KEY",
  "DATAFORSEO_LOGIN",
  "DATAFORSEO_PASSWORD",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "AIRTABLE_PAT",
  "AIRTABLE_BASE_ID",
  "AIRTABLE_PARTNERS_TABLE",
  "APP_PASSWORD",
  "APP_AUTH_SECRET",
] as const satisfies ReadonlyArray<keyof Env>

export type RequiredKey = (typeof REQUIRED_KEYS)[number]

export function validateEnv(): { ok: boolean; missing: RequiredKey[] } {
  const missing = REQUIRED_KEYS.filter((k) => !env[k])
  return { ok: missing.length === 0, missing }
}

export function requireEnv<K extends keyof Env>(key: K): NonNullable<Env[K]> {
  const value = env[key]
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${key}. ` +
        `Set it in .env.local (see .env.example).`,
    )
  }
  return value as NonNullable<Env[K]>
}

const { ok, missing } = validateEnv()
if (!ok) {
  console.warn(
    `[env] Missing required environment variables: ${missing.join(", ")}. ` +
      `Routes that depend on these will throw at call time. ` +
      `See .env.example for the full list.`,
  )
}
