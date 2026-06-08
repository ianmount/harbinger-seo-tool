import { NextResponse } from "next/server"
import { z } from "zod"
import { deriveSessionId } from "@/lib/jobs"
import { getRunForSession, setSeedProposal } from "@/lib/keyword-research-runs"
import { proposeSeeds } from "@/lib/keyword-research/seeds"

export const maxDuration = 120

const RegenerateSchema = z.object({
  instructions: z.string().trim().min(1).max(2000),
})

/**
 * POST /api/keywords/research/runs/[id]/regenerate-seeds
 * Body: { instructions: "<free-text revision request>" }
 *
 * Re-runs the seed proposal with the user's instructions folded into the
 * prompt (and the same excluded services as the original request). Stays in
 * seeds_review — the user keeps iterating until they approve.
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
  const parsed = RegenerateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", issues: parsed.error.flatten() },
      { status: 400 },
    )
  }

  const sessionId = await deriveSessionId()
  const run = await getRunForSession(id, sessionId)
  if (!run) return NextResponse.json({ error: "not_found" }, { status: 404 })
  if (run.status !== "seeds_review") {
    return NextResponse.json(
      { error: `Run is in status "${run.status}", expected "seeds_review".` },
      { status: 409 },
    )
  }

  try {
    const proposal = await proposeSeeds(run.domain, run.services, {
      excludeServices: run.config.excludeServices ?? [],
      instructions: parsed.data.instructions,
    })
    await setSeedProposal(id, proposal)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 502 })
  }

  const updated = await getRunForSession(id, sessionId)
  return NextResponse.json({ run: updated })
}
