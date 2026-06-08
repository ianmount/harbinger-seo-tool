import { NextResponse } from "next/server"
import { z } from "zod"
import { deriveSessionId } from "@/lib/jobs"
import {
  getRunForSession,
  setApprovedSeeds,
  setProspect,
  setStatus,
} from "@/lib/keyword-research-runs"
import { curateCandidates } from "@/lib/keyword-research/curate"
import { generateCandidates } from "@/lib/keyword-research/generate"

export const maxDuration = 300

const ApproveSeedsSchema = z.object({
  seeds: z.array(z.string().trim().min(1).max(200)).min(1).max(200),
})

/**
 * POST /api/keywords/research/runs/[id]/seeds
 * Body: { seeds: [approved seed strings] }
 *
 * Checkpoint 1 → 2. Records the approved seeds, generates national candidates
 * (keyword_suggestions + related_keywords per seed), curates them (cluster →
 * geo → negatives → competitors → narrow → balance), and stores the prospect
 * list for the user's manual prune. Synchronous: the user is waiting at this
 * checkpoint, and the work is bounded (2 calls per seed).
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
  const parsed = ApproveSeedsSchema.safeParse(body)
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

  // Dedupe approved seeds (lowercase-compare), preserve order.
  const seen = new Set<string>()
  const seeds: string[] = []
  for (const raw of parsed.data.seeds) {
    const s = raw.trim()
    const k = s.toLowerCase()
    if (!s || seen.has(k)) continue
    seen.add(k)
    seeds.push(s)
  }

  await setApprovedSeeds(id, seeds)

  try {
    const { raw, warnings } = await generateCandidates(seeds)
    if (raw.length === 0) {
      await setStatus(
        id,
        "failed",
        `No candidates returned for any seed.${
          warnings.length ? ` (${warnings.join("; ")})` : ""
        }`,
      )
      return NextResponse.json(
        { error: "no_candidates", warnings },
        { status: 502 },
      )
    }
    const { prospect, drops } = curateCandidates(raw, run.config)
    if (prospect.length === 0) {
      await setStatus(
        id,
        "failed",
        "Curation produced an empty prospect list — every candidate was filtered out. Loosen the market allowlist or negative categories.",
      )
      return NextResponse.json({ error: "empty_prospect", drops }, { status: 502 })
    }
    await setProspect(id, prospect, drops)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await setStatus(id, "failed", msg)
    return NextResponse.json({ error: msg }, { status: 502 })
  }

  const updated = await getRunForSession(id, sessionId)
  return NextResponse.json({ run: updated })
}
