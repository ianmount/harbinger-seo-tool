import { NextResponse } from "next/server"
import { getSupabase } from "@/lib/supabase"

export const dynamic = "force-dynamic"

/**
 * GET /api/scheduled-tasks/recent-runs?kind=technical_crawl|full_audit&partnerId=...
 *
 * Lists recent jobs for the Scheduled Tasks page. Filters:
 *   - kind in ('technical_crawl', 'full_audit') — only scheduled-task kinds
 *   - kind=foo            : narrow to one kind
 *   - partnerId=rec...    : narrow to one partner (matches input.partnerId)
 *
 * Caps at 50 rows. The page polls this every 30s while in-flight jobs
 * exist so the user sees rows flip from running → completed without a
 * manual refresh.
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const kind = url.searchParams.get("kind")
  const partnerId = url.searchParams.get("partnerId")

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
    .from("background_jobs")
    .select(
      "id, kind, status, title, result_path, needs_attention, attention_summary, error, created_at, updated_at, completed_at, input",
    )
    .order("created_at", { ascending: false })
    .limit(50)

  if (kind === "technical_crawl" || kind === "full_audit") {
    query = query.eq("kind", kind)
  } else {
    query = query.in("kind", ["technical_crawl", "full_audit"])
  }
  if (partnerId) {
    // input is jsonb { partnerId: "rec..." }; use Postgres ->> to filter.
    query = query.eq("input->>partnerId", partnerId)
  }

  const { data, error } = await query
  if (error) {
    console.error("[api/scheduled-tasks/recent-runs] failed:", error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ runs: data ?? [] })
}
