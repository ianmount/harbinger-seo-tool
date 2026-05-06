import { NextResponse } from "next/server"
import { inngest } from "@/lib/inngest/client"
import {
  createJob,
  KIND_LABELS,
  ROUTINE_SESSION_ID,
  type JobKind,
} from "@/lib/jobs"
import {
  computeNextRunAt,
  type Frequency,
  type TaskKind,
} from "@/lib/scheduling"
import { getSupabase } from "@/lib/supabase"

export const dynamic = "force-dynamic"

/**
 * POST /api/scheduled-tasks/run
 *
 * Single dispatcher endpoint hit by the desktop Claude Code Routine bot
 * once per tick. Sweeps `task_schedules` for rows where enabled AND
 * next_run_at <= now(), enqueues an Inngest job for each, and advances
 * each schedule's next_run_at.
 *
 * Authenticated via the bearer-token bypass in proxy.ts — the Routine
 * sends `Authorization: Bearer <ROUTINE_API_TOKEN>`.
 *
 * Returns a per-schedule report so the bot's logs stay debuggable.
 *
 * NB: schedules are advanced BEFORE firing to make the dispatch
 * at-most-once-per-tick: if the bot retries a transient network error
 * between fires, the same schedule won't double-fire on the retry.
 */

interface DueRow {
  id: string
  partner_id: string
  partner_name: string
  kind: string
  frequency: string
  day_of_week: number | null
  day_of_month: number | null
  next_run_at: string
}

function buildJobInput(
  kind: TaskKind,
  partnerId: string,
): { title: string; input: unknown } {
  if (kind === "technical_crawl") {
    return {
      title: `${KIND_LABELS.technical_crawl} (scheduled)`,
      input: { partnerId },
    }
  }
  return {
    title: `${KIND_LABELS.full_audit} (scheduled)`,
    input: { partnerId },
  }
}

export async function POST() {
  let supabase: ReturnType<typeof getSupabase>
  try {
    supabase = getSupabase()
  } catch (err) {
    const message = err instanceof Error ? err.message : "Supabase not configured"
    return NextResponse.json(
      { error: `Supabase configuration error: ${message}` },
      { status: 500 },
    )
  }

  const nowIso = new Date().toISOString()
  const { data: due, error } = await supabase
    .from("task_schedules")
    .select(
      "id, partner_id, partner_name, kind, frequency, day_of_week, day_of_month, next_run_at",
    )
    .eq("enabled", true)
    .lte("next_run_at", nowIso)
    .order("next_run_at", { ascending: true })

  if (error) {
    console.error("[api/scheduled-tasks/run] due-query failed:", error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const rows = (due ?? []) as DueRow[]
  const fired: Array<{
    scheduleId: string
    jobId: string
    kind: TaskKind
    partnerId: string
  }> = []
  const errors: Array<{ scheduleId: string; error: string }> = []

  for (const row of rows) {
    const kind = row.kind as TaskKind
    if (kind !== "technical_crawl" && kind !== "full_audit") {
      errors.push({
        scheduleId: row.id,
        error: `Unsupported kind ${row.kind}`,
      })
      continue
    }
    // Advance next_run_at first to claim the row before firing. If the
    // fire itself fails we lose this slot but the schedule keeps moving
    // forward — better than double-firing a paid run.
    const nextRunAt = computeNextRunAt(kind, row.frequency as Frequency, {
      dayOfWeek: row.day_of_week,
      dayOfMonth: row.day_of_month,
    }).toISOString()

    const { error: claimErr } = await supabase
      .from("task_schedules")
      .update({
        next_run_at: nextRunAt,
        last_run_at: nowIso,
        updated_at: nowIso,
      })
      .eq("id", row.id)
    if (claimErr) {
      errors.push({ scheduleId: row.id, error: claimErr.message })
      continue
    }

    try {
      const { title, input } = buildJobInput(kind, row.partner_id)
      const job = await createJob({
        kind: kind as JobKind,
        title: `${title} — ${row.partner_name}`,
        input,
        sessionId: ROUTINE_SESSION_ID,
      })
      await inngest.send({ name: "jobs/run", data: { jobId: job.id } })
      // Stamp the schedule with the job id so the UI can deep-link.
      await supabase
        .from("task_schedules")
        .update({ last_job_id: job.id })
        .eq("id", row.id)
      fired.push({
        scheduleId: row.id,
        jobId: job.id,
        kind,
        partnerId: row.partner_id,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : "fire failed"
      console.error(
        `[api/scheduled-tasks/run] fire failed for schedule ${row.id}:`,
        message,
      )
      errors.push({ scheduleId: row.id, error: message })
    }
  }

  return NextResponse.json({
    sweptAt: nowIso,
    dueCount: rows.length,
    fired,
    errors,
  })
}
