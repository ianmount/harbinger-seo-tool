import "server-only"
import type { GetStepTools } from "inngest"
import { sendJobCompletionEmail } from "@/lib/email"
import {
  cancelJob,
  completeJob,
  failJob,
  getJob,
  JobCancelledError,
  KIND_LABELS,
  markRunning,
  type JobKind,
  type JobRow,
} from "@/lib/jobs"
import { runAltTagsTask } from "@/lib/tasks/alt-tags"
import { runAuditTask } from "@/lib/tasks/audit"
import { runCompAnalysisTask } from "@/lib/tasks/comp-analysis"
import { runFullAuditTask } from "@/lib/tasks/full-audit"
import { runGbpHeatmapTask } from "@/lib/tasks/gbp-heatmap"
import { runInitialStrategyTask } from "@/lib/tasks/initial-strategy"
import { runKeywordResearchTask } from "@/lib/tasks/keyword-research"
import { runTechnicalCrawlTask } from "@/lib/tasks/technical-crawl"
import { inngest } from "./client"

/**
 * Per-kind task implementations live in `lib/tasks/<kind>.ts` and conform to
 * this interface. Phase 1 ships zero implementations — the dispatcher fails
 * with a clear "not yet wired" message until tasks land in Phase 2+.
 *
 * The runner (defined below) is responsible for status transitions and
 * email; the task body just needs to do the work and return its result.
 * Throwing aborts the job into `failed` with the thrown message.
 *
 * Tasks may use `ctx.step` to checkpoint long work across multiple Inngest
 * step.run blocks. Each step.run gets its own ~800s Vercel function budget
 * — Inngest re-invokes the function across step boundaries so cumulative
 * wall-clock can exceed 800s. Tasks that don't need this can ignore `step`
 * and their body runs inside a single outer step.run wrapper (see
 * `CHUNKED_TASKS` below).
 */
export type StepTools = GetStepTools<typeof inngest>

export interface TaskContext {
  jobId: string
  job: JobRow
  step: StepTools
}

export type TaskRunner = (ctx: TaskContext) => Promise<{
  result: unknown
  resultPath?: string
}>

const TASKS: Partial<Record<JobKind, TaskRunner>> = {
  audit: runAuditTask,
  alt_tags: runAltTagsTask,
  comp_analysis: runCompAnalysisTask,
  full_audit: runFullAuditTask,
  gbp_heatmap: runGbpHeatmapTask,
  initial_strategy: runInitialStrategyTask,
  keyword_research: runKeywordResearchTask,
  technical_crawl: runTechnicalCrawlTask,
}

/**
 * Tasks that manage their own Inngest step.run checkpoints internally. The
 * dispatcher does NOT wrap these in an outer step.run("run-task") — that
 * wrapper would force the entire body into one ~800s Vercel invocation,
 * defeating the chunking. Cumulative wall-clock for these tasks can exceed
 * 800s because Inngest re-invokes between step.run boundaries.
 *
 * Tasks NOT in this set get the default outer wrapper (single atomic
 * invocation, body re-executes from scratch on Inngest re-invocation if it
 * fails before completing).
 */
const CHUNKED_TASKS = new Set<JobKind>([
  "comp_analysis",
  "keyword_research",
  "gbp_heatmap",
])

/**
 * Shared onFailure handler. Runs in a separate Inngest invocation when a job
 * function exhausts its retries (or fails with retries:0) for any reason —
 * including Vercel's hard 800s function-timeout kill, instance recycles, and
 * OOM crashes. Without this, a killed function leaves its background_jobs row
 * stuck in `running` (the runtime is dead before the catch block fires).
 */
async function onJobFailure({
  event,
  error,
}: {
  event: { data: unknown }
  error: unknown
}): Promise<void> {
  // The original event is wrapped under event.data.event when invoked via the
  // Inngest failure pipeline.
  const original = (event.data as { event?: { data?: { jobId?: string } } })
    .event
  const jobId = original?.data?.jobId
  if (!jobId) return
  const message =
    error instanceof Error ? error.message : String(error ?? "Unknown error")
  try {
    const row = await getJob(jobId)
    if (!row) return
    if (
      row.status === "completed" ||
      row.status === "failed" ||
      row.status === "cancelled"
    ) {
      return
    }
    await failJob(
      jobId,
      message.includes("function") || message.toLowerCase().includes("timeout")
        ? `Function timed out or was killed before finishing: ${message}`
        : message,
    )
    const finalized = (await getJob(jobId)) ?? row
    await sendJobCompletionEmail(finalized)
  } catch (cleanupErr) {
    console.error(`[onFailure] cleanup for job ${jobId} threw:`, cleanupErr)
  }
}

/**
 * The dispatcher body, parameterised by which kinds a given Inngest function
 * is responsible for. Both functions subscribe to `jobs/run`; each loads the
 * row and bails immediately if `handles(kind)` is false, so exactly one runs a
 * given job to completion (partitioned by kind, no double markRunning).
 *
 * Splitting the worker this way lets the GBP heatmap function carry its own
 * retry policy. The shared `run-job` function keeps `retries: 0` because most
 * tasks make paid API calls inside a single un-checkpointed step, so a retry
 * would re-bill the whole task. The GBP heatmap function opts into retries
 * (see below) — safe there because every paid call lives inside a memoised
 * `step.run`, so a retry only re-runs the one failed batch.
 */
async function runJobBody(
  ctx: {
    event: { data: { jobId?: string } }
    step: StepTools
    logger: {
      info: (...a: unknown[]) => void
      error: (...a: unknown[]) => void
    }
  },
  handles: (kind: JobKind) => boolean,
) {
  const { event, step, logger } = ctx
  {
    const jobId = event.data.jobId
    if (!jobId) throw new Error("jobs/run event missing jobId")

    const job = await step.run("load-job", async () => {
      const row = await getJob(jobId)
      if (!row) throw new Error(`Job ${jobId} not found`)
      return row
    })

    // Kind partitioning: the other function owns this job.
    if (!handles(job.kind)) {
      return { skipped: true, reason: "kind-not-handled", kind: job.kind }
    }

    if (job.status !== "queued") {
      // Defensive: if a duplicate event lands, don't re-run a job that's
      // already in flight or terminal.
      logger.info(`Job ${jobId} status=${job.status}; skipping run`)
      return { skipped: true, status: job.status }
    }

    await step.run("mark-running", () => markRunning(jobId))

    const runner = TASKS[job.kind]
    if (!runner) {
      const message = `No task implementation registered for kind=${job.kind} (${KIND_LABELS[job.kind] ?? job.kind})`
      await step.run("fail-no-runner", () => failJob(jobId, message))
      const failed = (await getJob(jobId)) ?? job
      await step.run("send-email", () => sendJobCompletionEmail(failed))
      return { ok: false, reason: "no-runner" }
    }

    // Default path (non-chunked tasks): run the entire task inside one
    // step.run so Inngest caches its result. Without this wrapper, the
    // runner would re-execute on every Inngest re-invocation, hitting
    // Vercel's 800s ceiling repeatedly. We also write the heavy task
    // result to background_jobs.result inside the step rather than
    // returning it through Inngest's 4MiB-capped serialization layer; the
    // step returns a small { ok, resultPath } ack for the dashboard.
    //
    // Chunked path (CHUNKED_TASKS): the runner manages its own step.run
    // checkpoints and the dispatcher only wraps completeJob. Cumulative
    // wall-clock can exceed 800s because Inngest re-invokes the function
    // across the runner's step boundaries.
    let runResult: { ok: boolean; resultPath?: string } | null = null
    try {
      if (CHUNKED_TASKS.has(job.kind)) {
        const { result, resultPath } = await runner({ jobId, job, step })
        await step.run("complete-job", async () => {
          await completeJob(jobId, result, resultPath)
          return { ok: true }
        })
        runResult = { ok: true, resultPath }
      } else {
        runResult = await step.run("run-task", async () => {
          const { result, resultPath } = await runner({ jobId, job, step })
          await completeJob(jobId, result, resultPath)
          return { ok: true, resultPath }
        })
      }
    } catch (err) {
      // step.run rethrows as the original error class is collapsed into a
      // generic StepError. Identify cancellation by the `name` so we still
      // route to the cancelled branch.
      const isCancelled =
        err instanceof JobCancelledError ||
        (err as { name?: string })?.name === "JobCancelledError" ||
        (err instanceof Error && err.message.includes("JobCancelledError"))

      if (isCancelled) {
        logger.info(`Job ${jobId} cancelled`)
        await step.run("finalize-cancelled", () =>
          cancelJob(jobId, "Cancelled by user"),
        )
      } else {
        // Re-throw so Inngest's retry machinery (for functions that have
        // retries) gets a chance to re-run the failed step from its memoised
        // checkpoint. The retry replays completed steps and only re-executes
        // the one that threw. onJobFailure marks the row failed once retries
        // are exhausted. (For retries:0 functions this is equivalent to the
        // previous catch-and-fail behaviour.)
        const message = err instanceof Error ? err.message : String(err)
        logger.error(`Job ${jobId} failed:`, err)
        throw err instanceof Error ? err : new Error(message)
      }
    }
    void runResult

    const final = (await getJob(jobId)) ?? job
    // Skip email on cancellation — the user just clicked Stop, they don't
    // need a "your job is done" confirmation. Only send for completed/failed.
    if (final.status !== "cancelled") {
      await step.run("send-email", () => sendJobCompletionEmail(final))
    }
    return { ok: final.status === "completed", status: final.status }
  }
}

/**
 * Default worker: every kind except GBP heatmap. `retries: 0` — most tasks run
 * their paid work in a single un-checkpointed step, so a retry would re-bill.
 */
export const runJobFunction = inngest.createFunction(
  {
    id: "run-job",
    name: "Run background job",
    retries: 0,
    triggers: [{ event: "jobs/run" }],
    onFailure: onJobFailure,
  },
  (ctx) => runJobBody(ctx, (kind) => kind !== "gbp_heatmap"),
)

/**
 * GBP heatmap worker. Opts into retries because the scan is chunked into
 * `step.run` batches: a transient invocation failure (cold start, 5xx, recycle)
 * on any one of the many steps a large grid produces would otherwise abandon
 * the whole run with `retries: 0`, leaving the row to be killed by the 18-min
 * stale sweeper. With retries, Inngest replays the memoised completed batches
 * and re-runs only the failed one — so the re-bill is bounded to a single batch
 * of Maps calls, not the whole scan.
 */
export const runGbpHeatmapJobFunction = inngest.createFunction(
  {
    id: "run-gbp-heatmap-job",
    name: "Run GBP heatmap job",
    retries: 3,
    triggers: [{ event: "jobs/run" }],
    onFailure: onJobFailure,
  },
  (ctx) => runJobBody(ctx, (kind) => kind === "gbp_heatmap"),
)

export const inngestFunctions = [runJobFunction, runGbpHeatmapJobFunction]
