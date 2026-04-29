import { NextResponse } from "next/server"
import { z } from "zod"
import { getPartner } from "@/lib/airtable"
import { getSupabase } from "@/lib/supabase"
import { computeNextRunAt } from "@/lib/technical-crawl"

export const dynamic = "force-dynamic"

/**
 * GET  /api/technical-crawls/subscriptions
 * POST /api/technical-crawls/subscriptions
 *
 * One subscription per partner. POST upserts on partner_id so re-submitting
 * the same partner with a different schedule overwrites the previous one
 * cleanly (vs. erroring on the unique constraint).
 */
const createSchema = z.discriminatedUnion("frequency", [
  z.object({
    partnerId: z.string().min(1),
    frequency: z.literal("weekly"),
    dayOfWeek: z.number().int().min(0).max(6),
  }),
  z.object({
    partnerId: z.string().min(1),
    frequency: z.literal("monthly"),
    dayOfMonth: z.number().int().min(1).max(31),
  }),
])

export async function GET() {
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from("crawl_subscriptions")
    .select("*")
    .order("partner_name", { ascending: true })
  if (error) {
    console.error("[api/technical-crawls/subscriptions GET] failed:", error.message)
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
  const nextRunAt = computeNextRunAt(body.frequency, {
    dayOfWeek,
    dayOfMonth,
  }).toISOString()

  const supabase = getSupabase()
  const { data, error } = await supabase
    .from("crawl_subscriptions")
    .upsert(
      {
        partner_id: partner.id,
        partner_name: partner.name,
        frequency: body.frequency,
        day_of_week: dayOfWeek,
        day_of_month: dayOfMonth,
        enabled: true,
        next_run_at: nextRunAt,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "partner_id" },
    )
    .select("*")
    .single()

  if (error) {
    console.error("[api/technical-crawls/subscriptions POST] failed:", error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ subscription: data })
}
