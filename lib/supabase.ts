import "server-only"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { requireEnv } from "@/lib/env"

/**
 * Server-side Supabase client. Uses the service-role key, which bypasses
 * RLS — never import this from a client component or expose it through a
 * public route. The whole app sits behind APP_PASSWORD or a bearer token
 * (see proxy.ts), so we don't lean on RLS for tenancy.
 *
 * Cached per process so we're not re-creating a fetch-based client on every
 * request. Throws if SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY aren't set so
 * the Technical Crawls tab fails loudly instead of silently writing nowhere.
 */

let cached: SupabaseClient | null = null

/**
 * Normalize the SUPABASE_URL we got from env. People paste with trailing
 * slashes, leftover `/rest/v1` paths, or even a full dashboard URL — any
 * of which makes supabase-js build malformed REST paths and surface the
 * cryptic "Invalid path specified in request URL" error. Trim those
 * variants down to the canonical `https://<project>.supabase.co` origin.
 */
function normalizeUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "")
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error(
      `SUPABASE_URL must start with https:// — got "${raw}". Copy the "Project URL" from Supabase → Settings → API.`,
    )
  }
  // Strip anything after the host. The dashboard URL looks like
  // https://supabase.com/dashboard/project/<id> — that's the wrong value
  // and we'd rather fail loudly than silently send REST calls into the
  // dashboard's HTML routes.
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`SUPABASE_URL is not a valid URL: "${raw}".`)
  }
  if (parsed.hostname.includes("supabase.com") && parsed.pathname.length > 1) {
    throw new Error(
      `SUPABASE_URL looks like the Supabase dashboard URL ("${raw}"). Use the "Project URL" instead — it ends in supabase.co with no path.`,
    )
  }
  return `${parsed.protocol}//${parsed.host}`
}

export function getSupabase(): SupabaseClient {
  if (cached) return cached
  const url = normalizeUrl(requireEnv("SUPABASE_URL"))
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY")
  cached = createClient(url, key, {
    auth: {
      // Server-only client — never persist a session.
      persistSession: false,
      autoRefreshToken: false,
    },
  })
  return cached
}

// ── Row shapes (kept hand-typed; we don't generate types from Supabase) ────

export interface CrawlRunRow {
  id: string
  partner_id: string | null
  partner_name: string | null
  domain: string
  source: "manual" | "routine"
  status: "running" | "done" | "failed"
  started_at: string
  finished_at: string | null
  duration_seconds: number | null
  cost_usd: number | null
  summary: unknown | null
  lighthouse: unknown | null
  schema_coverage: unknown | null
  indexability: unknown | null
  sample_pages: unknown | null
  errors: unknown | null
}

export interface CrawlSubscriptionRow {
  id: string
  partner_id: string
  partner_name: string
  frequency: "weekly" | "monthly"
  day_of_week: number | null
  day_of_month: number | null
  enabled: boolean
  next_run_at: string
  last_run_at: string | null
  last_crawl_id: string | null
  created_at: string
  updated_at: string
}
