import { NextResponse } from "next/server"
import { canAccessJob, deriveSessionId, getJob } from "@/lib/jobs"

/**
 * GET /api/jobs/[id]
 * Returns the job row, scoped to the caller's session. Returns 404 even for
 * existing rows if the session_id doesn't match — this prevents one logged-in
 * window from polling a different login's jobs. Routine/scheduled jobs
 * (session_id="routine") are visible to any authenticated session, since
 * they have no real owner.
 *
 * Cache headers force fresh reads; this endpoint is the polling target so
 * stale CDN responses would defeat the whole flow.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params
  if (!id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 })
  }

  const sessionId = await deriveSessionId()
  const job = await getJob(id)
  if (!job || !canAccessJob(job, sessionId)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }

  return NextResponse.json(
    { job },
    { headers: { "Cache-Control": "no-store" } },
  )
}
