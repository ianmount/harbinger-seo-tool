import { NextResponse } from "next/server"
import {
  serpTaskGetForPoll,
  type SerpOrganicResult,
} from "@/lib/dataforseo"
import { deriveSessionId } from "@/lib/jobs"
import {
  completeRun,
  getAllRankTasks,
  getRunForSession,
  markRankTaskDone,
  type RankTaskRow,
} from "@/lib/keyword-research-runs"
import {
  buildLocationResults,
  hostKey,
  organicHost,
} from "@/lib/tasks/keyword-research"
import type { KeywordResearchResult } from "@/lib/types"

export const runtime = "nodejs"
export const maxDuration = 300

const POLL_CONCURRENCY = 10
const SAMPLE_SIZE = 8

/** Replicates the OLD (buggy) matcher: raw equality, no `www.` stripping. */
function legacyMatch(domain: string, target: string): boolean {
  const norm = (s: string) =>
    s.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase()
  return norm(domain) === norm(target)
}

async function mapWithConcurrency<T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const i = cursor++
        if (i >= items.length) return
        results[i] = await fn(items[i])
      }
    },
  )
  await Promise.all(workers)
  return results
}

/**
 * POST /api/keywords/research/runs/[id]/rescan
 *
 * Verification + free recovery for a completed run. Re-fetches each stored
 * SERP task via task_get (free under DataForSEO billing), recomputes the
 * target's rank with the fixed www-normalized matcher, writes the corrected
 * ranks back, and rebuilds the run result. Returns a diagnostic sample so you
 * can see the raw organic domains and whether the old matcher was missing
 * hits the new one catches.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params
  if (!id) return NextResponse.json({ error: "missing_id" }, { status: 400 })

  const sessionId = await deriveSessionId()
  const run = await getRunForSession(id, sessionId)
  if (!run) return NextResponse.json({ error: "not_found" }, { status: 404 })

  const allTasks = await getAllRankTasks(id)
  const pollable = allTasks.filter((t) => t.dfs_task_id)
  if (pollable.length === 0) {
    return NextResponse.json(
      { error: "No tasks with a DataForSEO task id to rescan." },
      { status: 409 },
    )
  }

  const target = hostKey(run.domain)

  interface Diagnostic {
    keyword: string
    location: string
    state: string
    oldMatch: number | null
    newMatch: number | null
    organicSample: { position: number; domain: string; url: string }[]
  }
  const diagnostics: Diagnostic[] = []
  let rescanned = 0
  let matchedNew = 0
  let matchedOldOnly = 0
  let recoveredHits = 0
  const errorSamples: string[] = []

  await mapWithConcurrency(pollable, POLL_CONCURRENCY, async (t: RankTaskRow) => {
    let res
    try {
      res = await serpTaskGetForPoll(t.dfs_task_id as string)
    } catch (err) {
      if (errorSamples.length < SAMPLE_SIZE) {
        errorSamples.push(
          `"${t.keyword}": ${err instanceof Error ? err.message : "fetch failed"}`,
        )
      }
      return
    }
    if (res.state === "error") {
      if (errorSamples.length < SAMPLE_SIZE) {
        errorSamples.push(`"${t.keyword}": ${res.statusCode} ${res.statusMessage}`)
      }
      return
    }
    if (res.state !== "done") return // still pending — leave as-is

    rescanned++
    const newHit = res.organic.find((o) => organicHost(o) === target)
    const oldHit = res.organic.find((o) => legacyMatch(o.domain, run.domain))
    const newRank = newHit ? newHit.position : null
    if (newRank !== null) matchedNew++
    if (oldHit && !newHit) matchedOldOnly++
    if (newRank !== null && (!oldHit || oldHit.position !== newRank)) {
      recoveredHits++
    }

    await markRankTaskDone(t.id, newRank)

    if (diagnostics.length < SAMPLE_SIZE) {
      diagnostics.push({
        keyword: t.keyword,
        location: t.location_slug,
        state: res.state,
        oldMatch: oldHit ? oldHit.position : null,
        newMatch: newRank,
        organicSample: res.organic
          .slice(0, 5)
          .map((o: SerpOrganicResult) => ({
            position: o.position,
            domain: o.domain,
            url: o.url,
          })),
      })
    }
  })

  // Rebuild the run result from the corrected tasks, preserving the original
  // cost/duration/warnings and appending a rescan note.
  const refreshed = await getAllRankTasks(id)
  const approvedCount =
    run.approvedKeywords?.length ??
    new Set(refreshed.map((t) => t.keyword.toLowerCase())).size
  const locations = buildLocationResults(
    run.locations,
    run.prospect,
    refreshed,
    approvedCount,
    run.seedProposal,
  )
  const prior = run.result
  const warnings = [...(prior?.warnings ?? [])]
  warnings.push(
    `Ranks rescanned ${new Date().toISOString().slice(0, 10)}: ${matchedNew}/${rescanned} keywords now have a rank for ${target} (matcher fixed to strip www).`,
  )
  if (errorSamples.length > 0) {
    warnings.push(`Rescan task errors (sample): ${errorSamples.join("; ")}`)
  }
  const result: KeywordResearchResult = {
    locations,
    costUsd: prior?.costUsd ?? run.costUsd ?? 0,
    durationSeconds: prior?.durationSeconds ?? 0,
    warnings,
  }
  await completeRun(id, result)

  return NextResponse.json({
    target,
    rescanned,
    matchedNew,
    matchedOldOnly,
    recoveredHits,
    errorSamples,
    diagnostics,
    result,
  })
}
