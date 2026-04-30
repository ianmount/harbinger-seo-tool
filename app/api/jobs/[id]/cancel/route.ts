import { NextResponse } from "next/server"
import { cancelJob, deriveSessionId, getJob } from "@/lib/jobs"

/**
 * POST /api/jobs/[id]/cancel
 * Marks a queued or running job as cancelled. Cooperative — the running
 * task observes the status flip at its next progress checkpoint and throws
 * JobCancelledError, which the dispatcher catches and finalizes cleanly.
 *
 * Session-scoped: returns 404 (not 403) for jobs from a different session,
 * matching the GET /api/jobs/[id] behavior.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params
  if (!id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 })
  }

  const sessionId = await deriveSessionId()
  const job = await getJob(id)
  if (!job || job.session_id !== sessionId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }

  // Already terminal — no-op. Return success so the UI can move on.
  if (
    job.status === "completed" ||
    job.status === "failed" ||
    job.status === "cancelled"
  ) {
    return NextResponse.json({ ok: true, status: job.status })
  }

  try {
    await cancelJob(id, "Cancelled by user")
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json(
      { error: `Cancel failed: ${msg}` },
      { status: 500 },
    )
  }

  return NextResponse.json({ ok: true, status: "cancelled" })
}
