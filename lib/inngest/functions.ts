import "server-only"
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
import { runInitialStrategyTask } from "@/lib/tasks/initial-strategy"
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
 */
export interface TaskContext {
  jobId: string
  job: JobRow
  // Future: progress reporter, cancellation signal, etc.
}

export type TaskRunner = (ctx: TaskContext) => Promise<{
  result: unknown
  resultPath?: string
}>

const TASKS: Partial<Record<JobKind, TaskRunner>> = {
  audit: runAuditTask,
  alt_tags: runAltTagsTask,
  comp_analysis: runCompAnalysisTask,
  initial_strategy: runInitialStrategyTask,
  technical_crawl: runTechnicalCrawlTask,
}

/**
 * The single Inngest function. One event (`jobs/run`) feeds it; it pulls the
 * row, dispatches by kind, and finalizes. Per-kind concurrency / rate limits
 * can be added later by splitting into one function per kind — for now the
 * task volume is tiny and a shared worker is enough.
 *
 * `retries: 0` because every task in this app makes external API calls
 * worth real money (Claude, DataForSEO). A retry on a partial failure could
 * double-charge. Tasks that *want* retries can opt in by re-throwing inside
 * step.run blocks once we get there.
 *
 * `onFailure` runs in a separate Inngest invocation when the main function
 * fails for any reason — including Vercel's hard 800s function-timeout
 * kill, instance recycles, and out-of-memory crashes. Without this, a
 * function that hits the timeout leaves its background_jobs row stuck in
 * `running` forever (the runtime is dead before the catch block fires).
 */
export const runJobFunction = inngest.createFunction(
  {
    id: "run-job",
    name: "Run background job",
    retries: 0,
    triggers: [{ event: "jobs/run" }],
    onFailure: async ({ event, error }) => {
      // The original event is wrapped under event.data.event when invoked
      // via the Inngest failure pipeline.
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
          message.includes("function") ||
            message.toLowerCase().includes("timeout")
            ? `Function timed out or was killed before finishing: ${message}`
            : message,
        )
        const finalized = (await getJob(jobId)) ?? row
        await sendJobCompletionEmail(finalized)
      } catch (cleanupErr) {
        console.error(
          `[onFailure] cleanup for job ${jobId} threw:`,
          cleanupErr,
        )
      }
    },
  },
  async ({ event, step, logger }) => {
    const jobId = event.data.jobId as string | undefined
    if (!jobId) throw new Error("jobs/run event missing jobId")

    const job = await step.run("load-job", async () => {
      const row = await getJob(jobId)
      if (!row) throw new Error(`Job ${jobId} not found`)
      return row
    })

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

    // The actual task runs INSIDE step.run so Inngest caches its result.
    // Without this wrapper, the runner re-executed every time Inngest
    // re-invoked the function for a subsequent step.run — meaning a
    // multi-step dispatcher ran the crawl multiple times and frequently
    // failed with "Could not find step to run; timed out" because the
    // re-execution was hitting the Vercel function timeout.
    //
    // We also write the heavy task result (audit bundles, full crawl rows,
    // alt-tag arrays) directly to background_jobs.result inside this step
    // rather than returning it through Inngest's serialization layer.
    // step.run output is capped at 4MiB and serialization at that scale was
    // flaky — Inngest reported "your server reset the connection while we
    // were reading the reply" on responses approaching the cap. The step
    // still returns a small ack ({ ok, resultPath }) so the run trace is
    // legible in the Inngest dashboard.
    let runResult: { ok: boolean; resultPath?: string } | null = null
    try {
      runResult = await step.run("run-task", async () => {
        const { result, resultPath } = await runner({ jobId, job })
        await completeJob(jobId, result, resultPath)
        return { ok: true, resultPath }
      })
    } catch (err) {
      // step.run rethrows as the original error class is collapsed into a
      // generic StepError. Identify cancellation by the `name` so we still
      // route to the cancelled branch.
      const isCancelled =
        err instanceof JobCancelledError ||
        (err as { name?: string })?.name === "JobCancelledError" ||
        (err instanceof Error &&
          err.message.includes("JobCancelledError"))

      if (isCancelled) {
        logger.info(`Job ${jobId} cancelled`)
        await step.run("finalize-cancelled", () =>
          cancelJob(jobId, "Cancelled by user"),
        )
      } else {
        const message = err instanceof Error ? err.message : String(err)
        logger.error(`Job ${jobId} failed:`, err)
        await step.run("fail-job", () => failJob(jobId, message))
      }
    }
    // Note: no separate "complete-job" step. completeJob() was called inside
    // run-task above — that's where the row flips to status=completed.
    void runResult

    const final = (await getJob(jobId)) ?? job
    // Skip email on cancellation — the user just clicked Stop, they don't
    // need a "your job is done" confirmation. Only send for completed/failed.
    if (final.status !== "cancelled") {
      await step.run("send-email", () => sendJobCompletionEmail(final))
    }
    return { ok: final.status === "completed", status: final.status }
  },
)

export const inngestFunctions = [runJobFunction]
