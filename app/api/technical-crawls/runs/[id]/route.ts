import { NextResponse } from "next/server"
import { getSupabase } from "@/lib/supabase"

export const dynamic = "force-dynamic"

/**
 * GET /api/technical-crawls/runs/[id]
 *
 * Returns the full crawl row, including the heavy JSONB columns (summary,
 * lighthouse, schema_coverage, indexability, sample_pages, errors). Used
 * by the dashboard detail view.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
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
    .from("crawl_runs")
    .select("*")
    .eq("id", id)
    .maybeSingle()

  if (error) {
    console.error(`[api/technical-crawls/runs/${id}] failed:`, error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!data) {
    return NextResponse.json({ error: "Crawl not found" }, { status: 404 })
  }
  return NextResponse.json({ run: data })
}
