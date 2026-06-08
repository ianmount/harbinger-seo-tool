import { NextResponse } from "next/server"
import { z } from "zod"
import { inngest } from "@/lib/inngest/client"
import { createJob, deriveSessionId } from "@/lib/jobs"
import { getRunForSession, setLocalizing } from "@/lib/keyword-research-runs"

const LocalizeSchema = z.object({
  keywords: z.array(z.string().trim().min(1).max(200)).min(1).max(1000),
})

/**
 * POST /api/keywords/research/runs/[id]/localize
 * Body: { keywords: [pruned keyword strings] }
 *
 * Checkpoint 2 → localize. Records the user's pruned keyword set, creates a
 * `keyword_research` background job (kind already registered in the Inngest
 * dispatcher), fires the event, and links the job to the run. The job runs
 * the paid passes: city volume → drop no-volume → SERP rank queue → assemble
 * → per-location CSVs.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params
  if (!id) return NextResponse.json({ error: "missing_id" }, { status: 400 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 })
  }
  const parsed = LocalizeSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", issues: parsed.error.flatten() },
      { status: 400 },
    )
  }

  const sessionId = await deriveSessionId()
  const run = await getRunForSession(id, sessionId)
  if (!run) return NextResponse.json({ error: "not_found" }, { status: 404 })
  if (run.status !== "keywords_review") {
    return NextResponse.json(
      { error: `Run is in status "${run.status}", expected "keywords_review".` },
      { status: 409 },
    )
  }

  // Keep only keywords that exist in the curated prospect list.
  const prospectSet = new Set(
    (run.prospect ?? []).map((c) => c.keyword.toLowerCase()),
  )
  const approved = parsed.data.keywords.filter((k) =>
    prospectSet.has(k.trim().toLowerCase()),
  )
  if (approved.length === 0) {
    return NextResponse.json(
      { error: "No approved keywords matched the curated prospect list." },
      { status: 400 },
    )
  }

  // Create the background job and wire it to the run.
  let job
  try {
    job = await createJob({
      kind: "keyword_research",
      title: `Keyword research — ${run.domain}`,
      input: { runId: id, keywords: approved },
      sessionId,
      resultPath: `/keywords/research/${id}`,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Supabase error: ${msg}` }, { status: 500 })
  }

  await setLocalizing(id, approved, job.id)

  try {
    await inngest.send({ name: "jobs/run", data: { jobId: job.id } })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Inngest error: ${msg}` }, { status: 500 })
  }

  const updated = await getRunForSession(id, sessionId)
  return NextResponse.json({ run: updated, jobId: job.id })
}
