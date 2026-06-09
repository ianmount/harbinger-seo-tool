import "server-only"
import { z } from "zod"
import { createCostAccumulator, withAuditCost } from "@/lib/audit-cost"
import {
  searchVolume,
  serpTaskGet,
  serpTaskPost,
  serpTasksReady,
  type SerpTaskHandle,
} from "@/lib/dataforseo"
import type { TaskContext, TaskRunner } from "@/lib/inngest/functions"
import {
  isCancelRequested,
  JobCancelledError,
  updateProgress,
} from "@/lib/jobs"
import {
  completeRun,
  getAllRankTasks,
  getPendingRankTasks,
  getRun,
  insertRankTasks,
  markRankTaskDone,
  type NewRankTask,
  setStatus,
} from "@/lib/keyword-research-runs"
import type {
  DfsLocation,
  KeywordResearchLocationResult,
  KeywordResearchResult,
  KeywordResearchResultRow,
  KeywordSource,
} from "@/lib/types"

/**
 * Keyword Research — localize phase (the paid background job).
 *
 * Chunked Inngest task: the SERP rank step uses DataForSEO's async Standard
 * queue, which can take many minutes for hundreds of (keyword × city)
 * lookups. Polling inside one Vercel invocation is capped at ~800s, so we
 * spread the work across `step.run` blocks with `step.sleep` between polls —
 * Inngest re-invokes the function across step boundaries, so the run can wait
 * far longer than 800s without any single invocation running long.
 *
 *   submit-tasks → city volume (live) per location, drop no-volume terms,
 *                  submit kept terms to the SERP queue (high priority) and
 *                  persist them to keyword_research_rank_tasks.
 *   poll-N       → intersect tasks_ready with our pending ids, collect each
 *                  finished SERP, record the target's rank. Repeats with a
 *                  sleep between rounds until nothing's pending or the cap.
 *   assemble     → build one result block per location from the rank-tasks
 *                  table; finalize the run.
 *
 * Cost is carried in each step's return value (acc per step) so it survives
 * re-invocations — same pattern as comp-analysis.
 */

const KeywordResearchInputSchema = z.object({
  runId: z.string().uuid(),
  keywords: z.array(z.string().min(1)).min(1),
})

const SERP_DEPTH = 20
const SERP_PRIORITY = 2 as const // high priority → faster queue turnaround
const MAX_POLLS = 40 // × POLL_SLEEP ≈ 20 min of queue wait, across invocations
const POLL_SLEEP = "30s"
const COLLECT_CONCURRENCY = 8

function stripDomain(domain: string): string {
  return domain
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase()
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

async function withStepCost<T>(
  work: () => Promise<T>,
): Promise<{ value: T; costUsd: number }> {
  const acc = createCostAccumulator()
  const value = await withAuditCost(acc, work)
  return { value, costUsd: acc.dataforseoUsd + acc.claudeUsd }
}

export const runKeywordResearchTask: TaskRunner = async ({
  jobId,
  job,
  step,
}: TaskContext) => {
  const parsed = KeywordResearchInputSchema.safeParse(job.input)
  if (!parsed.success) {
    throw new Error(
      `Invalid keyword research input: ${JSON.stringify(parsed.error.flatten())}`,
    )
  }
  const { runId, keywords } = parsed.data

  const checkCancel = async () => {
    if (await isCancelRequested(jobId)) throw new JobCancelledError(jobId)
  }

  try {
    let costUsd = 0
    const warnings: string[] = []

    // ── Phase 1: submit (one step). City volume → drop → queue SERP tasks. ──
    const submit = await step.run("submit-tasks-v1", () =>
      withStepCost(async () => {
        await checkCancel()
        const run = await getRun(runId)
        if (!run) throw new Error(`Keyword research run ${runId} not found`)
        const stepWarnings: string[] = []

        for (const loc of run.locations) {
          await updateProgress(jobId, {
            stage: "Pricing local demand",
            detail: `${loc.label} (${keywords.length} keywords)`,
          }).catch(() => {})
          const cityLoc: DfsLocation = { code: loc.locationCode }
          let volRows
          try {
            volRows = await searchVolume(keywords, cityLoc)
          } catch (err) {
            stepWarnings.push(
              `${loc.label}: city volume failed (${
                err instanceof Error ? err.message : "unknown"
              }). Skipping this market.`,
            )
            continue
          }
          const volByKw = new Map<string, number>()
          for (const r of volRows) {
            if (typeof r.search_volume === "number") {
              volByKw.set(r.keyword.toLowerCase(), r.search_volume)
            }
          }
          const kept = keywords.filter(
            (kw) => (volByKw.get(kw.toLowerCase()) ?? 0) > 0,
          )
          if (kept.length === 0) {
            stepWarnings.push(`${loc.label}: no keywords had local search volume.`)
            continue
          }

          await updateProgress(jobId, {
            stage: "Queueing SERP rank checks",
            detail: `${loc.label} — ${kept.length} keywords`,
          }).catch(() => {})
          let handles: SerpTaskHandle[] = []
          try {
            handles = await serpTaskPost(
              kept.map((kw) => ({
                keyword: kw,
                locationCode: loc.locationCode,
                locationLabel: loc.label,
                depth: SERP_DEPTH,
                priority: SERP_PRIORITY,
              })),
            )
          } catch (err) {
            stepWarnings.push(
              `${loc.label}: SERP task submission failed (${
                err instanceof Error ? err.message : "unknown"
              }).`,
            )
            handles = []
          }
          if (handles.length < kept.length) {
            stepWarnings.push(
              `${loc.label}: ${handles.length}/${kept.length} SERP tasks accepted by DataForSEO.`,
            )
          }
          const idByKw = new Map<string, string>()
          for (const h of handles) idByKw.set(h.keyword.toLowerCase(), h.id)

          const tasks: NewRankTask[] = kept.map((kw) => ({
            locationSlug: loc.slug,
            locationCode: loc.locationCode,
            keyword: kw,
            cityVolume: volByKw.get(kw.toLowerCase()) ?? null,
            dfsTaskId: idByKw.get(kw.toLowerCase()) ?? "",
          }))
          await insertRankTasks(runId, tasks)
        }
        return { warnings: stepWarnings }
      }),
    )
    costUsd += submit.costUsd
    warnings.push(...submit.value.warnings)

    // ── Phase 2: poll the queue across invocations. ─────────────────────────
    for (let i = 0; i < MAX_POLLS; i++) {
      const poll = await step.run(`poll-${i}`, () =>
        withStepCost(async () => {
          await checkCancel()
          const pending = (await getPendingRankTasks(runId)).filter(
            (t) => t.dfs_task_id,
          )
          if (pending.length === 0) return { remaining: 0, totalReady: 0 }

          let readyIds: Set<string>
          try {
            const ready = await serpTasksReady()
            readyIds = new Set(ready)
          } catch {
            return { remaining: pending.length, totalReady: -1 }
          }
          const collectable = pending.filter(
            (t) => t.dfs_task_id && readyIds.has(t.dfs_task_id),
          )
          await updateProgress(jobId, {
            stage: "Collecting SERP results",
            detail: `${pending.length} pending, ${collectable.length} ready this round`,
          }).catch(() => {})

          const target = stripDomain(
            (await getRun(runId))?.domain ?? "",
          )
          await mapWithConcurrency(collectable, COLLECT_CONCURRENCY, async (t) => {
            try {
              const serp = await serpTaskGet(t.dfs_task_id as string)
              const hit = serp.organic.find(
                (o) => stripDomain(o.domain) === target,
              )
              await markRankTaskDone(t.id, hit ? hit.position : null)
            } catch {
              // leave pending; a later poll may pick it up.
            }
          })

          const after = (await getPendingRankTasks(runId)).filter(
            (t) => t.dfs_task_id,
          )
          return { remaining: after.length, totalReady: readyIds.size }
        }),
      )
      costUsd += poll.costUsd
      if (poll.value.remaining === 0) break
      await step.sleep(`wait-${i}`, POLL_SLEEP)
    }

    // ── Phase 3: assemble (one step). ───────────────────────────────────────
    const finalCostUsd = Number(costUsd.toFixed(4))
    const assemble = await step.run("assemble-v1", async () => {
      const run = await getRun(runId)
      if (!run) throw new Error(`Keyword research run ${runId} not found`)
      const prospectByKw = new Map<string, { seed: string; source: KeywordSource }>()
      for (const c of run.prospect ?? []) {
        prospectByKw.set(c.keyword.toLowerCase(), {
          seed: c.seed,
          source: c.source,
        })
      }
      const allTasks = await getAllRankTasks(runId)
      const byLocation = new Map<string, typeof allTasks>()
      for (const t of allTasks) {
        const arr = byLocation.get(t.location_slug) ?? []
        if (!byLocation.has(t.location_slug)) byLocation.set(t.location_slug, arr)
        arr.push(t)
      }

      const locations: KeywordResearchLocationResult[] = run.locations.map(
        (loc) => {
          const tasks = byLocation.get(loc.slug) ?? []
          const rows: KeywordResearchResultRow[] = tasks.map((t) => {
            const meta = prospectByKw.get(t.keyword.toLowerCase())
            return {
              seed: meta?.seed ?? "",
              keyword: t.keyword,
              source: meta?.source ?? "suggestions",
              cityVolume: t.city_volume,
              currentRank: t.status === "done" ? t.rank : null,
            }
          })
          const droppedNoVolume = Math.max(0, keywords.length - tasks.length)
          const rankUnresolved = tasks.filter(
            (t) => t.status !== "done" || !t.dfs_task_id,
          ).length
          return {
            slug: loc.slug,
            label: loc.label,
            rows,
            droppedNoVolume,
            rankUnresolved,
          }
        },
      )

      const durationSeconds = Math.max(
        0,
        Math.round((Date.now() - new Date(job.created_at).getTime()) / 1000),
      )
      const result: KeywordResearchResult = {
        locations,
        costUsd: finalCostUsd,
        durationSeconds,
        warnings,
      }
      await completeRun(runId, result)
      return {
        runId,
        locations: locations.length,
        costUsd: finalCostUsd,
        durationSeconds,
      }
    })

    console.log(
      `[keyword-research:done] job=${jobId} run=${runId} locations=${assemble.locations} cost=$${finalCostUsd.toFixed(2)} duration=${assemble.durationSeconds}s`,
    )
    return { result: assemble, resultPath: `/keywords/research/${runId}` }
  } catch (err) {
    if (
      err instanceof JobCancelledError ||
      (err as { name?: string })?.name === "JobCancelledError"
    ) {
      await setStatus(runId, "cancelled").catch(() => {})
    } else {
      await setStatus(
        runId,
        "failed",
        err instanceof Error ? err.message : String(err),
      ).catch(() => {})
    }
    throw err
  }
}
