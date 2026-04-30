import { NextResponse } from "next/server"
import { deriveSessionId, listJobsForSession } from "@/lib/jobs"

/**
 * GET /api/jobs
 * Returns the up-to-25 most recent jobs for the current session, newest
 * first. The JobsTray polls this every few seconds while there's at least
 * one active job; once everything is terminal it falls back to refresh-on-
 * mount. Session_id is server-derived from the auth cookie.
 */
export async function GET(): Promise<Response> {
  const sessionId = await deriveSessionId()
  const jobs = await listJobsForSession(sessionId)
  return NextResponse.json(
    { jobs },
    { headers: { "Cache-Control": "no-store" } },
  )
}
