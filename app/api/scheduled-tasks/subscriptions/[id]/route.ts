import { NextResponse } from "next/server"
import { z } from "zod"
import {
  computeNextRunAt,
  type Frequency,
  type TaskKind,
} from "@/lib/scheduling"
import { getSupabase } from "@/lib/supabase"

export const dynamic = "force-dynamic"

/**
 * PATCH  /api/scheduled-tasks/subscriptions/[id]   — toggle enabled / change schedule
 * DELETE /api/scheduled-tasks/subscriptions/[id]   — remove the subscription
 *
 * Partial updates: pass only the fields you want to change. Toggling
 * `enabled` does not advance `next_run_at`; changing `frequency` /
 * `dayOf*` does. The `kind` of an existing schedule is immutable —
 * change a schedule's task type by deleting and recreating.
 */
const patchSchema = z.object({
  enabled: z.boolean().optional(),
  frequency: z.enum(["daily", "weekly", "monthly"]).optional(),
  dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
  dayOfMonth: z.number().int().min(1).max(31).nullable().optional(),
})

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON" },
      { status: 400 },
    )
  }
  const parsed = patchSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request body", issues: parsed.error.flatten() },
      { status: 400 },
    )
  }
  const body = parsed.data
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

  const existing = await supabase
    .from("task_schedules")
    .select("*")
    .eq("id", id)
    .maybeSingle()
  if (existing.error) {
    return NextResponse.json({ error: existing.error.message }, { status: 500 })
  }
  if (!existing.data) {
    return NextResponse.json({ error: "Subscription not found" }, { status: 404 })
  }

  const nextFrequency: Frequency = (body.frequency ?? existing.data.frequency) as Frequency
  const nextDayOfWeek =
    body.dayOfWeek !== undefined ? body.dayOfWeek : existing.data.day_of_week
  const nextDayOfMonth =
    body.dayOfMonth !== undefined ? body.dayOfMonth : existing.data.day_of_month
  const kind: TaskKind = existing.data.kind as TaskKind

  const update: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  }
  if (body.enabled !== undefined) update.enabled = body.enabled

  const scheduleChanged =
    body.frequency !== undefined ||
    body.dayOfWeek !== undefined ||
    body.dayOfMonth !== undefined

  if (scheduleChanged) {
    if (nextFrequency === "daily") {
      update.frequency = "daily"
      update.day_of_week = null
      update.day_of_month = null
      update.next_run_at = computeNextRunAt(kind, "daily").toISOString()
    } else if (nextFrequency === "weekly") {
      if (nextDayOfWeek == null) {
        return NextResponse.json(
          { error: "weekly schedule requires dayOfWeek" },
          { status: 400 },
        )
      }
      update.frequency = "weekly"
      update.day_of_week = nextDayOfWeek
      update.day_of_month = null
      update.next_run_at = computeNextRunAt(kind, "weekly", {
        dayOfWeek: nextDayOfWeek,
      }).toISOString()
    } else {
      if (nextDayOfMonth == null) {
        return NextResponse.json(
          { error: "monthly schedule requires dayOfMonth" },
          { status: 400 },
        )
      }
      update.frequency = "monthly"
      update.day_of_month = nextDayOfMonth
      update.day_of_week = null
      update.next_run_at = computeNextRunAt(kind, "monthly", {
        dayOfMonth: nextDayOfMonth,
      }).toISOString()
    }
  }

  const { data, error } = await supabase
    .from("task_schedules")
    .update(update)
    .eq("id", id)
    .select("*")
    .single()

  if (error) {
    console.error(
      `[api/scheduled-tasks/subscriptions/${id} PATCH] failed:`,
      error.message,
    )
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ subscription: data })
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
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
  const { error } = await supabase
    .from("task_schedules")
    .delete()
    .eq("id", id)
  if (error) {
    console.error(
      `[api/scheduled-tasks/subscriptions/${id} DELETE] failed:`,
      error.message,
    )
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
