import { NextResponse } from "next/server"
import { getSupabase } from "@/lib/supabase"

export const dynamic = "force-dynamic"

/**
 * GET /api/technical-crawls/subscriptions/due
 *
 * Used by the Claude Code desktop Routine on each daily tick. Returns
 * subscriptions whose `next_run_at` is in the past and whose `enabled`
 * flag is true. The Routine then POSTs each one to /run with
 * `source: "routine"`, which advances `next_run_at` server-side.
 *
 * Authenticated via the bearer-token bypass in proxy.ts — the Routine
 * sends `Authorization: Bearer <ROUTINE_API_TOKEN>`.
 */
export async function GET() {
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
  const nowIso = new Date().toISOString()
  const { data, error } = await supabase
    .from("crawl_subscriptions")
    .select("id, partner_id, partner_name, frequency, day_of_week, day_of_month, next_run_at, last_run_at, last_crawl_id")
    .eq("enabled", true)
    .lte("next_run_at", nowIso)
    .order("next_run_at", { ascending: true })

  if (error) {
    console.error("[api/technical-crawls/subscriptions/due] failed:", error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ due: data ?? [] })
}
