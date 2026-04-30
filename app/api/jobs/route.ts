import { NextResponse } from "next/server"
import { deriveSessionId, listJobsForSession, sweepStaleJobs } from "@/lib/jobs"

/**
 * GET /api/jobs
 * Returns the up-to-25 most recent jobs for the current session, newest
 * first. The JobsTray polls this every few seconds while there's at least
 * one active job; once everything is terminal it falls back to refresh-on-
 * mount. Session_id is server-derived from the auth cookie.
 *
 * Opportunistically sweeps stale `running` rows whose updated_at is older
 * than the Vercel function ceiling — covers the case where the dispatcher
 * was killed mid-task and onFailure didn't fire.
 */
export async function GET(): Promise<Response> {
  const sessionId = await deriveSessionId()
  // Best-effort; never fail the list call on a sweep error.
  void sweepStaleJobs().catch((err) =>
    console.error("[GET /api/jobs] sweep:", err),
  )
  const jobs = await listJobsForSession(sessionId)
  return NextResponse.json(
    { jobs },
    { headers: { "Cache-Control": "no-store" } },
  )
}
