import "server-only"
import { z } from "zod"
import { getPartner, saveArtifact } from "@/lib/partners"
import {
  computeTechnicalCrawlAttention,
  markJobAttention,
} from "@/lib/attention"
import type { TaskRunner } from "@/lib/inngest/functions"
import {
  isCancelRequested,
  JobCancelledError,
  updateProgress,
} from "@/lib/jobs"
import { getSupabase } from "@/lib/supabase"
import { runTechnicalCrawl, TechnicalCrawlError } from "@/lib/technical-crawl"

/**
 * Technical Crawl task. Wraps the `runTechnicalCrawl` engine and persists
 * a row in `crawl_runs` for both manual ("Run now" button on the schedule
 * pipeline) and scheduled (fired by /api/scheduled-tasks/run) entry
 * points. Schedule bookkeeping (next_run_at advancement, last_job_id) is
 * the dispatcher's responsibility, not this task's.
 */

export const TechnicalCrawlInputSchema = z
  .object({
    partnerId: z.string().min(1).optional(),
    url: z.string().min(3).optional(),
  })
  .refine((v) => v.partnerId || v.url, {
    message: "Either partnerId or url is required",
  })

export type TechnicalCrawlInput = z.infer<typeof TechnicalCrawlInputSchema>

function normalizeDomain(input: string): string {
  return input
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase()
}

export const runTechnicalCrawlTask: TaskRunner = async ({ jobId, job }) => {
  const parsed = TechnicalCrawlInputSchema.safeParse(job.input)
  if (!parsed.success) {
    throw new Error(
      `Invalid technical-crawl input: ${JSON.stringify(parsed.error.flatten())}`,
    )
  }

  const stage = async (label: string, detail?: string) => {
    if (await isCancelRequested(jobId)) throw new JobCancelledError(jobId)
    await updateProgress(jobId, { stage: label, detail }).catch(() => {})
  }

  // Resolve partner + domain.
  await stage("Resolving target")
  let partnerId: string | null = null
  let partnerName: string | null = null
  let domain: string
  if (parsed.data.partnerId) {
    const partner = await getPartner(parsed.data.partnerId).catch(() => null)
    if (!partner) {
      throw new Error(`Partner ${parsed.data.partnerId} not found`)
    }
    partnerId = partner.id
    partnerName = partner.name
    domain = normalizeDomain(partner.website)
  } else {
    domain = normalizeDomain(parsed.data.url ?? "")
  }
  if (!domain) {
    throw new Error("Empty domain")
  }

  // Insert running placeholder so the dashboard can show in-progress crawls.
  const supabase = getSupabase()
  const insert = await supabase
    .from("crawl_runs")
    .insert({
      partner_id: partnerId,
      partner_name: partnerName,
      domain,
      source: "manual",
      status: "running",
    })
    .select("*")
    .single()
  if (insert.error || !insert.data) {
    throw new Error(
      `Supabase insert failed: ${insert.error?.message ?? "unknown"}`,
    )
  }
  const crawlId = insert.data.id as string

  await stage("Crawling site", domain)

  // Heartbeat + cancel-watch — same pattern as alt-tags. runTechnicalCrawl
  // is one big call (DFS crawl + Lighthouse + JSON-LD + indexability) that
  // can take 5-13 min on bigger sites. Without this we go silent for the
  // whole run, the user can't tell live from stuck, and a cancel click
  // doesn't reach the worker until the job's natural checkpoints (which
  // there aren't any of inside runTechnicalCrawl).
  const startedAt = Date.now()
  const elapsedS = () => Math.round((Date.now() - startedAt) / 1000)
  const heartbeat = setInterval(() => {
    void updateProgress(jobId, {
      stage: "Crawling site",
      detail: `${domain} — ${elapsedS()}s elapsed`,
    }).catch(() => {})
  }, 15_000)
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
    result = await Promise.race([
      runTechnicalCrawl({ domain }),
      cancelWatcher,
    ])
  } catch (err) {
    clearInterval(heartbeat)
    const message = err instanceof Error ? err.message : "Unknown error"
    await supabase
      .from("crawl_runs")
      .update({
        status: "failed",
        finished_at: new Date().toISOString(),
        errors: [message],
      })
      .eq("id", crawlId)
    if (err instanceof JobCancelledError) {
      throw err
    }
    if (err instanceof TechnicalCrawlError) {
      throw new Error(`Crawl failed: ${message}`)
    }
    throw err
  }
  clearInterval(heartbeat)

  await stage("Saving results")
  const update = await supabase
    .from("crawl_runs")
    .update({
      status: "done",
      finished_at: result.finishedAt,
      duration_seconds: result.durationSeconds,
      cost_usd: result.costUsd,
      summary: result.summary,
      lighthouse: result.lighthouse,
      schema_coverage: result.schemaCoverage,
      indexability: result.indexability,
      sample_pages: result.samplePages,
      issue_pages: result.issuePages,
      errors: result.errors,
    })
    .eq("id", crawlId)
    .select("*")
    .single()
  if (update.error) {
    throw new Error(`Supabase update failed: ${update.error.message}`)
  }

  await markJobAttention(jobId, computeTechnicalCrawlAttention(result))

  if (partnerId) {
    await saveArtifact({
      partnerId,
      kind: "technical_crawl",
      title: `${partnerName ?? domain} — Technical crawl`,
      data: {
        crawlId,
        domain,
        finishedAt: result.finishedAt,
        durationSeconds: result.durationSeconds,
        costUsd: result.costUsd,
      },
      jobId,
    }).catch((err) => {
      console.warn(
        `[technical-crawl] failed to save artifact for partner ${partnerId}:`,
        err,
      )
    })
  }

  return {
    result: { runId: crawlId, run: update.data },
    // Per-run viewer reuses CrawlDetail; lives under /scheduled-tasks/runs/<crawlId>.
    resultPath: `/scheduled-tasks/runs/${crawlId}`,
  }
}
