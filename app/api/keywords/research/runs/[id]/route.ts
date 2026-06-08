import { NextResponse } from "next/server"
import { deriveSessionId } from "@/lib/jobs"
import { getRunForSession } from "@/lib/keyword-research-runs"

/**
 * GET /api/keywords/research/runs/[id]
 * Returns the run, scoped to the caller's session (404 otherwise). This is
 * the polling target for in-progress runs, so responses are never cached.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params
  if (!id) return NextResponse.json({ error: "missing_id" }, { status: 400 })

  const sessionId = await deriveSessionId()
  const run = await getRunForSession(id, sessionId)
  if (!run) return NextResponse.json({ error: "not_found" }, { status: 404 })

  return NextResponse.json({ run }, { headers: { "Cache-Control": "no-store" } })
}
