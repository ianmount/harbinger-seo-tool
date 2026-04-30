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
  const result = await withAuditCost(cost, () =>
    generateAltTags({
      domain: parsed.data.domain,
      maxPages: parsed.data.maxPages,
      skipImagesWithAlt: parsed.data.skipImagesWithAlt,
    }),
  )

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
