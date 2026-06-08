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
import type { TaskRunner } from "@/lib/inngest/functions"
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
 * The interactive part (seed proposal → approval → candidate generation →
 * curation → manual prune) runs synchronously in the API routes. By the time
 * this task fires, the run has an approved, pruned keyword list. This task
 * does the expensive per-city work the skill's Steps 5-6 describe:
 *
 *   1. City volume — google_ads/search_volume per location (accepts city
 *      codes). Drop any keyword with no local volume; that's what makes each
 *      market's list market-specific.
 *   2. SERP rank — submit the kept keywords to DataForSEO's async Standard
 *      organic queue (task_post, 100/call), poll tasks_ready, collect each
 *      finished task, and record the target's organic position.
 *   3. Assemble — one result block per location (the per-location CSV rows),
 *      read back from keyword_research_rank_tasks.
 *
 * Everything (city volume + rank) is persisted to the rank-tasks table so the
 * assembly reads from one source and partial results survive a slow queue.
 */

const KeywordResearchInputSchema = z.object({
  runId: z.string().uuid(),
  keywords: z.array(z.string().min(1)).min(1),
})

const SERP_DEPTH = 20
const POLL_INTERVAL_MS = 20_000
const MAX_POLLS = 30 // ~10 minutes of polling after an initial settle delay
const INITIAL_SETTLE_MS = 15_000
const COLLECT_CONCURRENCY = 8

function stripDomain(domain: string): string {
  return domain
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase()
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
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

async function runLocalizePipeline(
  jobId: string,
  runId: string,
  keywords: string[],
): Promise<{ result: unknown; resultPath: string }> {
  const startedAt = Date.now()
  const warnings: string[] = []
  const cost = createCostAccumulator()

  const run = await getRun(runId)
  if (!run) throw new Error(`Keyword research run ${runId} not found`)

  const target = stripDomain(run.domain)
  const prospectByKw = new Map<string, { seed: string; source: KeywordSource }>()
  for (const c of run.prospect ?? []) {
    prospectByKw.set(c.keyword.toLowerCase(), { seed: c.seed, source: c.source })
  }

  const progress = (stage: string, detail?: string) =>
    updateProgress(jobId, { stage, detail }).catch(() => {})

  await withAuditCost(cost, async () => {
    // ── Phase 1: city volume + drop + queue SERP tasks, per location. ──────
    for (const loc of run.locations) {
      if (await isCancelRequested(jobId)) throw new JobCancelledError(jobId)
      await progress(
        "Pricing local demand",
        `${loc.label} (${keywords.length} keywords)`,
      )
      const cityLoc: DfsLocation = { code: loc.locationCode }
      let volRows
      try {
        volRows = await searchVolume(keywords, cityLoc)
      } catch (err) {
        warnings.push(
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
      // Keep keywords with local demand; drop the rest (market-specificity).
      const kept = keywords.filter((kw) => (volByKw.get(kw.toLowerCase()) ?? 0) > 0)
      if (kept.length === 0) {
        warnings.push(`${loc.label}: no keywords had local search volume.`)
        continue
      }

      await progress("Queueing SERP rank checks", loc.label)
      let handles: SerpTaskHandle[] = []
      try {
        handles = await serpTaskPost(
          kept.map((kw) => ({
            keyword: kw,
            locationCode: loc.locationCode,
            locationLabel: loc.label,
            depth: SERP_DEPTH,
          })),
        )
      } catch (err) {
        warnings.push(
          `${loc.label}: SERP task submission failed (${
            err instanceof Error ? err.message : "unknown"
          }).`,
        )
        handles = []
      }
      const idByKw = new Map<string, string>()
      for (const h of handles) idByKw.set(h.keyword.toLowerCase(), h.id)

      const tasks: NewRankTask[] = kept.map((kw) => ({
        locationSlug: loc.slug,
        locationCode: loc.locationCode,
        keyword: kw,
        cityVolume: volByKw.get(kw.toLowerCase()) ?? null,
        // Empty string sentinel for keywords that failed to submit — they
        // still appear in the CSV with city volume but no rank.
        dfsTaskId: idByKw.get(kw.toLowerCase()) ?? "",
      }))
      await insertRankTasks(runId, tasks)
    }

    // ── Phase 2: poll the Standard queue and collect ranks. ────────────────
    // Give DFS a moment before the first poll — freshly-posted tasks aren't
    // ready instantly.
    await sleep(INITIAL_SETTLE_MS)
    for (let poll = 0; poll < MAX_POLLS; poll++) {
      if (await isCancelRequested(jobId)) throw new JobCancelledError(jobId)
      const pending = (await getPendingRankTasks(runId)).filter(
        (t) => t.dfs_task_id, // sentinel "" / null → never submitted, skip
      )
      if (pending.length === 0) break

      let readyIds: Set<string>
      try {
        readyIds = new Set(await serpTasksReady())
      } catch (err) {
        warnings.push(
          `tasks_ready poll failed (${
            err instanceof Error ? err.message : "unknown"
          }); retrying.`,
        )
        await sleep(POLL_INTERVAL_MS)
        continue
      }
      const collectable = pending.filter(
        (t) => t.dfs_task_id && readyIds.has(t.dfs_task_id),
      )

      await progress(
        "Collecting SERP results",
        `${pending.length} pending, ${collectable.length} ready this round`,
      )

      await mapWithConcurrency(collectable, COLLECT_CONCURRENCY, async (t) => {
        try {
          const serp = await serpTaskGet(t.dfs_task_id as string)
          const hit = serp.organic.find((o) => stripDomain(o.domain) === target)
          await markRankTaskDone(t.id, hit ? hit.position : null)
        } catch {
          // Leave the row pending; a later poll may pick it up. If it never
          // resolves, it surfaces as rank-unresolved (blank rank).
        }
      })

      await sleep(POLL_INTERVAL_MS)
    }
  })

  // ── Phase 3: assemble per-location results from the rank-tasks table. ────
  await progress("Assembling results")
  const allTasks = await getAllRankTasks(runId)
  const byLocation = new Map<string, typeof allTasks>()
  for (const t of allTasks) {
    const arr = byLocation.get(t.location_slug) ?? []
    if (!byLocation.has(t.location_slug)) byLocation.set(t.location_slug, arr)
    arr.push(t)
  }

  const locations: KeywordResearchLocationResult[] = run.locations.map((loc) => {
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
  })

  const totalCostUsd = cost.dataforseoUsd + cost.claudeUsd
  const result: KeywordResearchResult = {
    locations,
    costUsd: Number(totalCostUsd.toFixed(4)),
    durationSeconds: Math.round((Date.now() - startedAt) / 1000),
    warnings,
  }

  await completeRun(runId, result)

  console.log(
    `[keyword-research:done] job=${jobId} run=${runId} domain=${target} locations=${locations.length} cost=$${totalCostUsd.toFixed(2)} duration=${result.durationSeconds}s`,
  )

  return {
    result: {
      runId,
      locations: locations.length,
      costUsd: result.costUsd,
      durationSeconds: result.durationSeconds,
    },
    resultPath: `/keywords/research/${runId}`,
  }
}

export const runKeywordResearchTask: TaskRunner = async ({ jobId, job }) => {
  const parsed = KeywordResearchInputSchema.safeParse(job.input)
  if (!parsed.success) {
    throw new Error(
      `Invalid keyword research input: ${JSON.stringify(parsed.error.flatten())}`,
    )
  }
  const { runId, keywords } = parsed.data
  try {
    return await runLocalizePipeline(jobId, runId, keywords)
  } catch (err) {
    // Mirror the failure onto the run row so the tab reflects it. Cancellation
    // is finalized as cancelled by the dispatcher; mark the run to match.
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
