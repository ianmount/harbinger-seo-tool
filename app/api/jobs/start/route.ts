import { NextResponse } from "next/server"
import { z } from "zod"
import { inngest } from "@/lib/inngest/client"
import { createJob, deriveSessionId, type JobKind } from "@/lib/jobs"

const KINDS = [
  "audit",
  "comp_analysis",
  "initial_strategy",
  "technical_crawl",
  "alt_tags",
] as const

const StartSchema = z.object({
  kind: z.enum(KINDS),
  title: z.string().min(1).max(200),
  // Free-form per-task params; each task validates its own input.
  input: z.unknown().optional(),
  // Where to land the user when they click "View results" (e.g. an Audit's
  // detail page). Falls back to /jobs/<id> if omitted.
  resultPath: z.string().startsWith("/").optional(),
})

/**
 * POST /api/jobs/start
 * Body: { kind, title, input?, resultPath? }
 * Returns: { jobId }
 *
 * Inserts a `queued` row in `background_jobs`, fires a `jobs/run` Inngest
 * event, and returns immediately. The Inngest function picks up the event,
 * runs the matching task, and finalizes the row. The client polls
 * /api/jobs/[id] for status.
 */
export async function POST(request: Request): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 })
  }
  const parsed = StartSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", issues: parsed.error.flatten() },
      { status: 400 },
    )
  }

  const sessionId = await deriveSessionId()
  const job = await createJob({
    kind: parsed.data.kind as JobKind,
    title: parsed.data.title,
    input: parsed.data.input ?? {},
    sessionId,
    resultPath: parsed.data.resultPath,
  })

  await inngest.send({ name: "jobs/run", data: { jobId: job.id } })

  return NextResponse.json({ jobId: job.id, kind: job.kind, status: job.status })
}
