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
  "full_audit",
  "keyword_research",
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

  // Catch each step individually so the failure surfaces a useful message
  // instead of an opaque 500. The toast on /audit reads `body.error` —
  // returning a clear string here is the fastest path to debugging deploy-
  // time misconfiguration (missing env var, table missing, etc.).
  let sessionId: string
  try {
    sessionId = await deriveSessionId()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[jobs/start] deriveSessionId failed:", msg)
    return NextResponse.json(
      { error: `Auth session error: ${msg}` },
      { status: 500 },
    )
  }

  let job
  try {
    job = await createJob({
      kind: parsed.data.kind as JobKind,
      title: parsed.data.title,
      input: parsed.data.input ?? {},
      sessionId,
      resultPath: parsed.data.resultPath,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[jobs/start] createJob failed:", msg)
    return NextResponse.json(
      { error: `Supabase error: ${msg}` },
      { status: 500 },
    )
  }

  try {
    await inngest.send({ name: "jobs/run", data: { jobId: job.id } })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[jobs/start] inngest.send failed:", msg)
    // Roll back the row so the user can retry without a stuck "queued" job.
    return NextResponse.json(
      { error: `Inngest error: ${msg}` },
      { status: 500 },
    )
  }

  return NextResponse.json({ jobId: job.id, kind: job.kind, status: job.status })
}
