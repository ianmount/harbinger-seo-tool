import { NextResponse } from "next/server"
import { getSupabase } from "@/lib/supabase"

export const dynamic = "force-dynamic"

/**
 * GET /api/technical-crawls/list?partnerId=...&limit=...
 *
 * Lists past crawls for the dashboard. Without a `partnerId` returns the
 * most recent runs across all partners (used by the "Recent" view).
 *
 * Returns shallow rows — heavyweight JSONB columns are omitted to keep
 * the list payload small. Use /runs/[id] for the full crawl payload.
 */
const SHALLOW_COLUMNS =
  "id, partner_id, partner_name, domain, source, status, started_at, finished_at, duration_seconds, cost_usd"

export async function GET(request: Request) {
  const url = new URL(request.url)
  const partnerId = url.searchParams.get("partnerId")
  const limitParam = url.searchParams.get("limit")
  const limit = Math.min(
    Math.max(1, Number(limitParam) > 0 ? Number(limitParam) : 50),
    200,
  )

  let supabase: ReturnType<typeof getSupabase>
  try {
    supabase = getSupabase()
  } catch (err) {
    const message = err instanceof Error ? err.message : "Supabase not configured"
    return NextResponse.json(
      { error: `Supabase configuration error: ${message}` },
      { status: 500 },
    )
  }
  let query = supabase
    .from("crawl_runs")
    .select(SHALLOW_COLUMNS)
    .order("started_at", { ascending: false })
    .limit(limit)

  if (partnerId) {
    query = query.eq("partner_id", partnerId)
  }

  const { data, error } = await query
  if (error) {
    console.error("[api/technical-crawls/list] failed:", error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ runs: data ?? [] })
}
