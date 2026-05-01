import { NextResponse } from "next/server"
import { getSupabase } from "@/lib/supabase"

export const dynamic = "force-dynamic"

/**
 * GET /api/scheduled-tasks/attention
 *
 * Returns recent scheduled-task jobs flagged as needs_attention=true. The
 * dashboard surfaces these as cards on top of the schedule pipeline. Only
 * scheduled task kinds (technical_crawl, full_audit) are included — the
 * Audit tab's manual runs are not part of the scheduled pipeline view.
 *
 * Filters:
 *   - needs_attention = true
 *   - kind in ('technical_crawl', 'full_audit')
 *   - status = 'completed' (no point flagging in-flight or failed runs)
 *   - dismissed_at is null (client-side dismissal also honored via
 *     localStorage; this is a server-side soft-delete column reserved for
 *     future use, currently unused)
 *
 * Caps the result at 50 rows for the dashboard. Older flagged runs are
 * still queryable directly but won't show up here.
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
  const { data, error } = await supabase
    .from("background_jobs")
    .select(
      "id, kind, status, title, attention_summary, completed_at, created_at, result_path",
    )
    .eq("needs_attention", true)
    .eq("status", "completed")
    .in("kind", ["technical_crawl", "full_audit"])
    .order("completed_at", { ascending: false })
    .limit(50)
  if (error) {
    console.error("[api/scheduled-tasks/attention] failed:", error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ items: data ?? [] })
}
