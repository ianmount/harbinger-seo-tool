import "server-only"
import { z } from "zod"
import { createCostAccumulator, withAuditCost } from "@/lib/audit-cost"
import { searchVolume, serpRankedDomains } from "@/lib/dataforseo"
import type { TaskContext, TaskRunner } from "@/lib/inngest/functions"
import {
  isCancelRequested,
  JobCancelledError,
  updateProgress,
} from "@/lib/jobs"
import {
  completeRun,
  getAllRankTasks,
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
 * this fires, the run has an approved, pruned keyword list. This task does
 * the expensive per-city work:
 *
 *   price-tasks → city volume (live google_ads/search_volume) per location;
 *                 drop terms with no local volume; persist the survivors
 *                 (with city volume) to keyword_research_rank_tasks.
 *   probe-N     → rank each survivor with the LIVE SERP endpoint
 *                 (serp/google/organic/live/advanced), chunked across
 *                 step.run blocks so a large list spans multiple short
 *                 Vercel invocations. Records the target's organic position.
 *   assemble    → one result block per location, read from the rank-tasks
 *                 table; finalize the run.
 *
 * We use the LIVE SERP endpoint rather than the async Standard task queue:
 * the queue repeatedly failed to return ready tasks (the same issue that made
 * an earlier implementation abandon it), whereas live SERP is what the Audit
 * and Comp Analysis tabs use reliably. Live costs ~3× per lookup but it works.
 *
 * Chunked Inngest task: each chunk's step.run carries its own cost in the
 * return value so the total survives re-invocations (same pattern as
 * comp-analysis).
 */

const KeywordResearchInputSchema = z.object({
  runId: z.string().uuid(),
  keywords: z.array(z.string().min(1)).min(1),
})

const SERP_DEPTH = 20
const SERP_CHUNK_SIZE = 50
const SERP_CONCURRENCY = 10

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

interface ProbeTask {
  id: string
  keyword: string
  locationCode: number
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

    // ── Phase 1: city volume → drop no-volume → persist rank tasks. ─────────
    const price = await step.run("price-tasks-v2", () =>
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
          const tasks: NewRankTask[] = kept.map((kw) => ({
            locationSlug: loc.slug,
            locationCode: loc.locationCode,
            keyword: kw,
            cityVolume: volByKw.get(kw.toLowerCase()) ?? null,
            // dfs_task_id unused for the live-SERP flow.
            dfsTaskId: "",
          }))
          await insertRankTasks(runId, tasks)
        }

        // Return a stable, ordered probe list so chunk boundaries are
        // deterministic across Inngest re-invocations.
        const all = (await getAllRankTasks(runId))
          .slice()
          .sort((a, b) => a.id.localeCompare(b.id))
        const probeTasks: ProbeTask[] = all.map((t) => ({
          id: t.id,
          keyword: t.keyword,
          locationCode: t.location_code,
        }))
        return {
          warnings: stepWarnings,
          target: stripDomain(run.domain),
          probeTasks,
        }
      }),
    )
    costUsd += price.costUsd
    warnings.push(...price.value.warnings)
    const { target, probeTasks } = price.value

    // ── Phase 2: rank each survivor via the live SERP endpoint, chunked. ────
    const chunkCount = Math.max(1, Math.ceil(probeTasks.length / SERP_CHUNK_SIZE))
    for (let ci = 0; ci < chunkCount; ci++) {
      const chunk = probeTasks.slice(
        ci * SERP_CHUNK_SIZE,
        (ci + 1) * SERP_CHUNK_SIZE,
      )
      if (chunk.length === 0) continue
      const probe = await step.run(`probe-${ci}`, () =>
        withStepCost(async () => {
          await checkCancel()
          await updateProgress(jobId, {
            stage: "Checking ranks",
            detail: `batch ${ci + 1}/${chunkCount} (${probeTasks.length} keyword×city lookups)`,
          }).catch(() => {})
          await mapWithConcurrency(chunk, SERP_CONCURRENCY, async (t) => {
            try {
              const hits = await serpRankedDomains(
                t.keyword,
                { code: t.locationCode },
                { depth: SERP_DEPTH },
              )
              const hit = hits.find((h) => stripDomain(h.domain) === target)
              await markRankTaskDone(t.id, hit ? hit.rankAbsolute : null)
            } catch {
              // Leave pending → surfaces as rank-unresolved. A single failed
              // lookup shouldn't sink the whole chunk.
            }
          })
          return null
        }),
      )
      costUsd += probe.costUsd
    }

    // ── Phase 3: assemble per-location results. ─────────────────────────────
    const finalCostUsd = Number(costUsd.toFixed(4))
    const assemble = await step.run("assemble-v2", async () => {
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
          const rankUnresolved = tasks.filter((t) => t.status !== "done").length
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
