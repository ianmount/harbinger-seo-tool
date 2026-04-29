import { NextResponse } from "next/server"
import { z } from "zod"
import { getPartner } from "@/lib/airtable"
import { getSupabase } from "@/lib/supabase"
import {
  computeNextRunAt,
  runTechnicalCrawl,
  TechnicalCrawlError,
} from "@/lib/technical-crawl"

export const dynamic = "force-dynamic"
export const maxDuration = 800

/**
 * POST /api/technical-crawls/run
 *
 * Body shape (one of):
 *   { partnerId: "rec...", source?: "manual" | "routine" }
 *   { url: "example.com", source?: "manual" | "routine" }
 *
 * Persists a new row in `crawl_runs`. When invoked from a routine for a
 * subscribed partner, also bumps the partner's `next_run_at` and caches
 * the row id on the subscription.
 *
 * Returns the persisted row.
 */
const bodySchema = z.union([
  z.object({
    partnerId: z.string().min(1),
    source: z.enum(["manual", "routine"]).optional(),
  }),
  z.object({
    url: z.string().min(3),
    source: z.enum(["manual", "routine"]).optional(),
  }),
])

function normalizeDomain(input: string): string {
  return input
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase()
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
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request body", issues: parsed.error.flatten() },
      { status: 400 },
    )
  }
  const body = parsed.data
  const source = body.source ?? "manual"

  // Resolve partner + domain.
  let partnerId: string | null = null
  let partnerName: string | null = null
  let domain: string

  if ("partnerId" in body) {
    const partner = await getPartner(body.partnerId).catch(() => null)
    if (!partner) {
      return NextResponse.json(
        { error: `Partner ${body.partnerId} not found in Airtable` },
        { status: 404 },
      )
    }
    partnerId = partner.id
    partnerName = partner.name
    domain = normalizeDomain(partner.website)
  } else {
    domain = normalizeDomain(body.url)
  }

  if (!domain) {
    return NextResponse.json({ error: "Empty domain" }, { status: 400 })
  }

  // getSupabase() throws if SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are
  // unset or malformed. Catch it explicitly so the browser sees a clean
  // 500 with a typed error message instead of a connection abort.
  let supabase: ReturnType<typeof getSupabase>
  try {
    supabase = getSupabase()
  } catch (err) {
    const message = err instanceof Error ? err.message : "Supabase not configured"
    console.error("[api/technical-crawls/run] supabase init failed:", message)
    return NextResponse.json(
      { error: `Supabase configuration error: ${message}` },
      { status: 500 },
    )
  }

  // Insert a "running" placeholder so the dashboard can show in-progress
  // crawls and operators can correlate logs. We update it to "done" /
  // "failed" once the engine returns.
  const insert = await supabase
    .from("crawl_runs")
    .insert({
      partner_id: partnerId,
      partner_name: partnerName,
      domain,
      source,
      status: "running",
    })
    .select("*")
    .single()
  if (insert.error || !insert.data) {
    console.error(
      "[api/technical-crawls/run] insert failed:",
      insert.error?.message,
    )
    return NextResponse.json(
      { error: `Supabase insert failed: ${insert.error?.message ?? "unknown"}` },
      { status: 500 },
    )
  }
  const crawlId = insert.data.id as string

  try {
    const result = await runTechnicalCrawl({ domain })

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
      console.error(
        "[api/technical-crawls/run] update failed:",
        update.error.message,
      )
      return NextResponse.json(
        { error: `Supabase update failed: ${update.error.message}` },
        { status: 500 },
      )
    }

    // If this was a routine fire on a subscribed partner, advance the
    // schedule. We re-read the subscription so we have its frequency +
    // day fields without requiring the routine to pass them.
    if (partnerId && source === "routine") {
      const sub = await supabase
        .from("crawl_subscriptions")
        .select("frequency, day_of_week, day_of_month")
        .eq("partner_id", partnerId)
        .maybeSingle()
      if (sub.data) {
        const next = computeNextRunAt(sub.data.frequency, {
          dayOfWeek: sub.data.day_of_week,
          dayOfMonth: sub.data.day_of_month,
        })
        await supabase
          .from("crawl_subscriptions")
          .update({
            last_run_at: result.finishedAt,
            last_crawl_id: crawlId,
            next_run_at: next.toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("partner_id", partnerId)
      }
    }

    return NextResponse.json({ run: update.data })
  } catch (error) {
    console.error("[api/technical-crawls/run] crawl failed:", error)
    const message = error instanceof Error ? error.message : "Unknown error"
    await supabase
      .from("crawl_runs")
      .update({
        status: "failed",
        finished_at: new Date().toISOString(),
        errors: [message],
      })
      .eq("id", crawlId)
    const status = error instanceof TechnicalCrawlError ? 502 : 500
    return NextResponse.json(
      { error: message, runId: crawlId },
      { status },
    )
  }
}
