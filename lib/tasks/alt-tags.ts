import "server-only"
import { z } from "zod"
import { generateAltTags } from "@/lib/alt-tags"
import {
  createCostAccumulator,
  totalCostUsd,
  withAuditCost,
} from "@/lib/audit-cost"
import type { TaskRunner } from "@/lib/inngest/functions"
import {
  isCancelRequested,
  JobCancelledError,
  updateProgress,
} from "@/lib/jobs"

/**
 * Alt-tags task. Wraps `lib/alt-tags.generateAltTags()` with progress
 * writes, cooperative cancellation at start, and cost tracking.
 *
 * `lib/alt-tags` doesn't expose an onProgress hook, so the only natural
 * cancel-check is before the work starts. Acceptable trade-off: the run
 * is bounded by maxPages × Claude calls and rarely exceeds a few minutes
 * — refunding a queued cancel is the main use case anyway.
 */

export const AltTagsInputSchema = z.object({
  domain: z.string().min(3),
  maxPages: z.number().int().min(1).max(1000).optional(),
  skipImagesWithAlt: z.boolean().optional(),
})

export type AltTagsInput = z.infer<typeof AltTagsInputSchema>

export const runAltTagsTask: TaskRunner = async ({ jobId, job }) => {
  const parsed = AltTagsInputSchema.safeParse(job.input)
  if (!parsed.success) {
    throw new Error(
      `Invalid alt-tags input: ${JSON.stringify(parsed.error.flatten())}`,
    )
  }

  if (await isCancelRequested(jobId)) throw new JobCancelledError(jobId)
  await updateProgress(jobId, {
    stage: `Crawling ${parsed.data.domain}`,
  }).catch(() => {})

  const cost = createCostAccumulator()
  const startedAt = Date.now()
  const elapsedS = () => Math.round((Date.now() - startedAt) / 1000)

  // Heartbeat: lib/alt-tags doesn't expose progress hooks, so we surface a
  // "still running, X seconds in" stage every 15s. Two purposes — it tells
  // the user the run isn't dead, and it bumps `updated_at` so the stale-job
  // sweeper in /api/jobs doesn't false-positive a long-but-healthy run.
  const heartbeat = setInterval(() => {
    void updateProgress(jobId, {
      stage: `Generating alt tags`,
      detail: `${elapsedS()}s elapsed (crawl + Claude)`,
    }).catch(() => {})
  }, 15_000)

  // Cancel watcher races against the work — if the user clicks Cancel,
  // Promise.race rejects with JobCancelledError and the dispatcher
  // finalizes as cancelled. The actual generateAltTags() call is
  // abandoned (it'll keep running until the function dies), so any
  // already-incurred DataForSEO/Claude cost is sunk.
  const cancelWatcher = (async () => {
    while (true) {
      await new Promise((r) => setTimeout(r, 5000))
      if (await isCancelRequested(jobId)) {
        throw new JobCancelledError(jobId)
      }
    }
  })()

  let result
  try {
    result = await withAuditCost(cost, () =>
      Promise.race([
        generateAltTags({
          domain: parsed.data.domain,
          maxPages: parsed.data.maxPages,
          skipImagesWithAlt: parsed.data.skipImagesWithAlt,
        }),
        cancelWatcher,
      ]),
    )
  } finally {
    clearInterval(heartbeat)
  }

  const costUsd = totalCostUsd(cost)
  console.log(
    `[alt-tags:done] job=${jobId} domain=${parsed.data.domain} pages=${result.pagesCrawled} images=${result.imagesFound} processed=${result.imagesProcessed} cost=$${costUsd.toFixed(4)}`,
  )

  return {
    result: {
      rows: result.rows,
      pagesCrawled: result.pagesCrawled,
      pagesWithImages: result.pagesWithImages,
      imagesFound: result.imagesFound,
      imagesProcessed: result.imagesProcessed,
      durationMs: result.durationMs,
      costUsd,
      dataforseoUsd: cost.dataforseoUsd,
      claudeUsd: cost.claudeUsd,
    },
    resultPath: `/tools/alt-tags?job=${jobId}`,
  }
}
