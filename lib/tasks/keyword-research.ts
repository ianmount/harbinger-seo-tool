import "server-only"
import { z } from "zod"
import { createCostAccumulator, withAuditCost } from "@/lib/audit-cost"
import {
  searchVolume,
  serpTaskGetForPoll,
  serpTaskPost,
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
  markRankTaskFailed,
  type NewRankTask,
  type RankTaskRow,
  setStatus,
} from "@/lib/keyword-research-runs"
import type {
  DfsLocation,
  KeywordCandidate,
  KeywordResearchLocation,
  KeywordResearchLocationResult,
  KeywordResearchResult,
  KeywordResearchResultRow,
  KeywordSource,
} from "@/lib/types"

/**
 * Keyword Research — localize phase (the paid background job).
 *
 *   submit-tasks → city volume (live google_ads/search_volume) per location;
 *                  drop terms with no local volume; submit the survivors to
 *                  DataForSEO's Standard SERP queue (task_post) and persist
 *                  each with its DFS task id.
 *   poll-N       → for each still-pending task, GET task_get/regular directly
 *                  (NOT tasks_ready, which never surfaced our tasks). Record
 *                  the target's rank when done; mark failed (with the DFS
 *                  message) on a server-side error; leave queued tasks for the
 *                  next round. Chunked across step.run + step.sleep so the
 *                  wait spans short invocations.
 *   assemble     → one result block per location; finalize the run.
 *
 * Why Standard queue + direct task_get polling: it's ~3× cheaper than live
 * (you pay only at task_post; task_get is free), and polling task_get per task
 * is reliable where tasks_ready was not — and it surfaces the real per-task
 * status so a server-side failure is visible instead of an endless wait.
 */

const KeywordResearchInputSchema = z.object({
  runId: z.string().uuid(),
  keywords: z.array(z.string().min(1)).min(1),
})

const SERP_DEPTH = 20
// Normal priority = cheapest Standard tier. Tasks take a little longer to
// clear the queue, but task_get polling is free and we wait via step.sleep.
const SERP_PRIORITY = 1 as const
const POLL_CONCURRENCY = 10
const MAX_POLLS = 60 // × POLL_SLEEP ≈ 30 min of queue wait, across invocations
const POLL_SLEEP = "30s"
const MAX_ERROR_SAMPLES = 5

/**
 * Canonical host key for domain matching. Strips scheme, any path, and a
 * leading `www.`, lowercased — matching the normalization every other domain
 * helper in this repo uses (dataforseo-ai.ts, branded-keywords.ts, etc.).
 * The previous matcher compared raw strings without stripping `www.`, so a
 * bare input domain never matched DataForSEO's www-prefixed organic host.
 */
export function hostKey(input: string): string {
  let s = input.trim().toLowerCase()
  if (/^[a-z]+:\/\//.test(s)) {
    try {
      s = new URL(s).hostname
    } catch {
      /* fall through to string stripping */
    }
  }
  return s
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "")
}

/** Host key for a SERP organic result — prefer the URL's hostname, fall back
 * to the bare `domain` field. */
export function organicHost(o: { domain: string; url: string }): string {
  if (o.url) {
    try {
      return hostKey(new URL(o.url).hostname)
    } catch {
      /* fall through */
    }
  }
  return hostKey(o.domain)
}

/**
 * Build the per-location result blocks from the run's rank tasks. Shared by
 * the localize task's assemble step and the rescan route so both produce
 * identical output. `approvedCount` is the size of the approved keyword set
 * (drives the droppedNoVolume count).
 */
export function buildLocationResults(
  locations: KeywordResearchLocation[],
  prospect: KeywordCandidate[] | null,
  allTasks: RankTaskRow[],
  approvedCount: number,
): KeywordResearchLocationResult[] {
  const prospectByKw = new Map<string, { seed: string; source: KeywordSource }>()
  for (const c of prospect ?? []) {
    prospectByKw.set(c.keyword.toLowerCase(), { seed: c.seed, source: c.source })
  }
  const byLocation = new Map<string, RankTaskRow[]>()
  for (const t of allTasks) {
    const arr = byLocation.get(t.location_slug) ?? []
    if (!byLocation.has(t.location_slug)) byLocation.set(t.location_slug, arr)
    arr.push(t)
  }
  return locations.map((loc) => {
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
    return {
      slug: loc.slug,
      label: loc.label,
      rows,
      droppedNoVolume: Math.max(0, approvedCount - tasks.length),
      rankUnresolved: tasks.filter((t) => t.status !== "done").length,
    }
  })
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

    // ── Phase 1: city volume → drop no-volume → submit SERP queue tasks. ────
    const submit = await step.run("submit-tasks-v3", () =>
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
        return { warnings: stepWarnings, target: hostKey(run.domain) }
      }),
    )
    costUsd += submit.costUsd
    warnings.push(...submit.value.warnings)
    const { target } = submit.value

    // ── Phase 2: poll task_get per pending task, across invocations. ────────
    for (let i = 0; i < MAX_POLLS; i++) {
      const poll = await step.run(`poll-v3-${i}`, () =>
        withStepCost(async () => {
          await checkCancel()
          const pending = (await getPendingRankTasks(runId)).filter(
            (t) => t.dfs_task_id,
          )
          if (pending.length === 0) {
            return { remaining: 0, done: 0, errors: [] as string[] }
          }

          await updateProgress(jobId, {
            stage: "Collecting SERP ranks",
            detail: `${pending.length} still in queue`,
          }).catch(() => {})

          const errorSamples: string[] = []
          await mapWithConcurrency(pending, POLL_CONCURRENCY, async (t) => {
            try {
              const res = await serpTaskGetForPoll(t.dfs_task_id as string)
              if (res.state === "done") {
                const hit = res.organic.find((o) => organicHost(o) === target)
                await markRankTaskDone(t.id, hit ? hit.position : null)
              } else if (res.state === "error") {
                await markRankTaskFailed(t.id)
                if (errorSamples.length < MAX_ERROR_SAMPLES) {
                  errorSamples.push(
                    `"${t.keyword}": ${res.statusCode} ${res.statusMessage}`,
                  )
                }
              }
              // pending → leave for the next round.
            } catch {
              // transient fetch error — leave pending, retry next round.
            }
          })

          const after = (await getPendingRankTasks(runId)).filter(
            (t) => t.dfs_task_id,
          )
          return {
            remaining: after.length,
            done: pending.length - after.length,
            errors: errorSamples,
          }
        }),
      )
      costUsd += poll.costUsd
      if (poll.value.errors.length > 0) {
        warnings.push(
          `SERP task errors (sample): ${poll.value.errors.join("; ")}`,
        )
      }
      if (poll.value.remaining === 0) break
      await step.sleep(`wait-v3-${i}`, POLL_SLEEP)
    }

    // ── Phase 3: assemble per-location results. ─────────────────────────────
    const finalCostUsd = Number(costUsd.toFixed(4))
    const assemble = await step.run("assemble-v3", async () => {
      const run = await getRun(runId)
      if (!run) throw new Error(`Keyword research run ${runId} not found`)
      const allTasks = await getAllRankTasks(runId)
      const locations = buildLocationResults(
        run.locations,
        run.prospect,
        allTasks,
        keywords.length,
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
