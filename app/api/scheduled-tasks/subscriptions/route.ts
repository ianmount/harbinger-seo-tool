import { NextResponse } from "next/server"
import { z } from "zod"
import { getPartner } from "@/lib/airtable"
import {
  computeNextRunAt,
  type Frequency,
  type TaskKind,
} from "@/lib/scheduling"
import { getSupabase } from "@/lib/supabase"

export const dynamic = "force-dynamic"

/**
 * GET  /api/scheduled-tasks/subscriptions
 * POST /api/scheduled-tasks/subscriptions
 *
 * Unified schedule pipeline replacing the old per-kind crawl subscriptions
 * routes. One row per (partner, kind) pair — POST upserts on that pair so
 * re-submitting the same partner+kind with a different schedule overwrites
 * the previous row cleanly (vs. erroring on the unique constraint).
 */

const KIND_VALUES = ["technical_crawl", "full_audit"] as const

const baseFields = {
  partnerId: z.string().min(1),
  kind: z.enum(KIND_VALUES),
}

const createSchema = z.discriminatedUnion("frequency", [
  z.object({
    ...baseFields,
    frequency: z.literal("daily"),
  }),
  z.object({
    ...baseFields,
    frequency: z.literal("weekly"),
    dayOfWeek: z.number().int().min(0).max(6),
  }),
  z.object({
    ...baseFields,
    frequency: z.literal("monthly"),
    dayOfMonth: z.number().int().min(1).max(31),
  }),
])

function safeSupabase():
  | { ok: true; client: ReturnType<typeof getSupabase> }
  | { ok: false; response: NextResponse } {
  try {
    return { ok: true, client: getSupabase() }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Supabase not configured"
    return {
      ok: false,
      response: NextResponse.json(
        { error: `Supabase configuration error: ${message}` },
        { status: 500 },
      ),
    }
  }
}

export async function GET() {
  const safe = safeSupabase()
  if (!safe.ok) return safe.response
  const supabase = safe.client
  const { data, error } = await supabase
    .from("task_schedules")
    .select("*")
    .order("partner_name", { ascending: true })
  if (error) {
    console.error("[api/scheduled-tasks/subscriptions GET] failed:", error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ subscriptions: data ?? [] })
}

export async function POST(request: Request) {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON" },
      { status: 400 },
    )
  }
  const parsed = createSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request body", issues: parsed.error.flatten() },
      { status: 400 },
    )
  }
  const body = parsed.data

  const partner = await getPartner(body.partnerId).catch(() => null)
  if (!partner) {
    return NextResponse.json(
      { error: `Partner ${body.partnerId} not found in Airtable` },
      { status: 404 },
    )
  }

  const dayOfWeek = body.frequency === "weekly" ? body.dayOfWeek : null
  const dayOfMonth = body.frequency === "monthly" ? body.dayOfMonth : null
  const frequency: Frequency = body.frequency
  const kind: TaskKind = body.kind
  const nextRunAt = computeNextRunAt(kind, frequency, {
    dayOfWeek,
    dayOfMonth,
  }).toISOString()

  const safe = safeSupabase()
  if (!safe.ok) return safe.response
  const supabase = safe.client
  const { data, error } = await supabase
    .from("task_schedules")
    .upsert(
      {
        partner_id: partner.id,
        partner_name: partner.name,
        kind,
        frequency,
        day_of_week: dayOfWeek,
        day_of_month: dayOfMonth,
        enabled: true,
        next_run_at: nextRunAt,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "partner_id,kind" },
    )
    .select("*")
    .single()

  if (error) {
    console.error("[api/scheduled-tasks/subscriptions POST] failed:", error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ subscription: data })
}
