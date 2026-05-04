import { NextResponse } from "next/server"
import { getPartners } from "@/lib/airtable"
import { getDailyClicks, GSCError, listSites } from "@/lib/gsc"
import { findBestGscSite } from "@/lib/gsc-site-match"
import { GA4Error, getSeoReport, listProperties } from "@/lib/ga4"
import { findBestGa4Property } from "@/lib/ga4-site-match"
import { getSupabase } from "@/lib/supabase"
import type {
  PartnerSnapshot,
  PartnerSnapshotPeriod,
  PartnerSnapshotRun,
} from "@/lib/types"

export const dynamic = "force-dynamic"
export const maxDuration = 120

// ── In-memory cache (per serverless instance) ─────────────────────────────

interface CacheEntry {
  snapshots: PartnerSnapshot[]
  expiresAt: number
}

const CACHE_TTL_MS = 10 * 60 * 1000
const cache = new Map<string, CacheEntry>()

// ── Helpers ───────────────────────────────────────────────────────────────

function isoToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

function isoOffset(base: string, days: number): string {
  const d = new Date(`${base}T00:00:00`)
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

function periodLength(startDate: string, endDate: string): number {
  const a = new Date(`${startDate}T00:00:00`)
  const b = new Date(`${endDate}T00:00:00`)
  return Math.round((b.getTime() - a.getTime()) / 86_400_000) + 1
}

/** Aggregate daily GSC rows into a single period summary. */
function aggregatePeriod(
  rows: Awaited<ReturnType<typeof getDailyClicks>>,
): PartnerSnapshotPeriod {
  let clicks = 0
  let impressions = 0
  let positionSum = 0
  for (const row of rows) {
    clicks += row.clicks
    impressions += row.impressions
    positionSum += row.position * row.impressions
  }
  return {
    clicks,
    impressions,
    avgCtr: impressions > 0 ? clicks / impressions : 0,
    avgPosition: impressions > 0 ? positionSum / impressions : null,
  }
}

/** Concurrency-limited map. Safe because JS is single-threaded. */
async function pMap<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let qi = 0
  async function worker() {
    while (qi < items.length) {
      const i = qi++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  )
  return results
}

// ── Latest runs per partner ────────────────────────────────────────────────

async function fetchLatestRunsPerPartner(): Promise<
  Map<string, PartnerSnapshotRun>
> {
  const map = new Map<string, PartnerSnapshotRun>()
  try {
    const supabase = getSupabase()
    // Grab the last 200 rows and take most-recent per partnerId in JS.
    // 200 rows > 100 partners × 2 kinds so we'll capture at least one run each.
    const { data: rows } = await supabase
      .from("background_jobs")
      .select(
        "id, kind, status, needs_attention, attention_summary, completed_at, result_path, input",
      )
      .in("kind", ["technical_crawl", "full_audit"])
      .not("input->>partnerId", "is", null)
      .order("created_at", { ascending: false })
      .limit(200)

    for (const row of rows ?? []) {
      const partnerId = (row.input as Record<string, unknown>)
        ?.partnerId as string
      if (partnerId && !map.has(partnerId)) {
        map.set(partnerId, {
          id: row.id as string,
          kind: row.kind as string,
          status: row.status as string,
          needsAttention: Boolean(row.needs_attention),
          attentionSummary: (row.attention_summary as unknown) ?? null,
          completedAt: (row.completed_at as string | null) ?? null,
          resultPath: (row.result_path as string | null) ?? null,
        })
      }
    }
  } catch {
    // Best-effort — missing latest runs just shows null on tiles.
  }
  return map
}

// ── Main handler ──────────────────────────────────────────────────────────

export async function GET(request: Request) {
  const url = new URL(request.url)
  const today = isoToday()
  const endDate = url.searchParams.get("endDate") ?? today
  const startDate =
    url.searchParams.get("startDate") ?? isoOffset(endDate, -27)

  if (startDate > endDate) {
    return NextResponse.json(
      { error: "startDate must be on or before endDate" },
      { status: 400 },
    )
  }

  const cacheKey = `${startDate}_${endDate}`
  const cached = cache.get(cacheKey)
  if (cached && Date.now() < cached.expiresAt) {
    return NextResponse.json({
      snapshots: cached.snapshots,
      dateRange: { startDate, endDate },
      cachedAt: new Date(cached.expiresAt - CACHE_TTL_MS).toISOString(),
    })
  }

  // Calculate prior period (same length, immediately before)
  const len = periodLength(startDate, endDate)
  const priorEndDate = isoOffset(startDate, -1)
  const priorStartDate = isoOffset(priorEndDate, -(len - 1))

  // Fetch shared data in parallel
  const [partners, allSites, allProperties, latestRuns] = await Promise.all([
    getPartners().catch(() => [] as Awaited<ReturnType<typeof getPartners>>),
    listSites("partners").catch(() => []),
    listProperties({ account: "partners" }).catch(() => []),
    fetchLatestRunsPerPartner(),
  ])

  const snapshots = await pMap(
    partners,
    async (partner): Promise<PartnerSnapshot> => {
      const gscSiteUrl = findBestGscSite(partner.website, allSites)
      const ga4Prop = findBestGa4Property(partner.website, allProperties)
      const resolvedGa4 =
        partner.ga4PropertyId != null
          ? partner.ga4PropertyId.startsWith("properties/")
            ? partner.ga4PropertyId
            : `properties/${partner.ga4PropertyId}`
          : ga4Prop?.propertyId ?? null

      let current: PartnerSnapshotPeriod | null = null
      let prior: PartnerSnapshotPeriod | null = null
      let ga4: PartnerSnapshot["ga4"] = null
      let error: string | null = null

      if (gscSiteUrl) {
        try {
          const [curRows, priorRows] = await Promise.all([
            getDailyClicks({
              account: "partners",
              siteUrl: gscSiteUrl,
              startDate,
              endDate,
            }),
            getDailyClicks({
              account: "partners",
              siteUrl: gscSiteUrl,
              startDate: priorStartDate,
              endDate: priorEndDate,
            }),
          ])
          current = aggregatePeriod(curRows)
          prior = aggregatePeriod(priorRows)
        } catch (err) {
          error =
            err instanceof GSCError
              ? err.message
              : err instanceof Error
                ? err.message
                : "GSC fetch failed"
        }
      }

      if (resolvedGa4) {
        try {
          const report = await getSeoReport({
            account: "partners",
            propertyId: resolvedGa4,
            startDate,
            endDate,
          })
          ga4 = {
            sessions: report.sessions,
            conversions: report.conversions,
            conversionsConfigured: report.conversionsConfigured,
          }
        } catch (err) {
          if (!(err instanceof GA4Error)) {
            console.warn(
              `[partners/snapshot] GA4 fetch failed for ${partner.name}:`,
              err,
            )
          }
          // Non-fatal — ga4 stays null
        }
      }

      return {
        partner,
        gscSiteUrl,
        ga4PropertyId: resolvedGa4,
        current,
        prior,
        ga4,
        latestRun: latestRuns.get(partner.id) ?? null,
        error,
      }
    },
    10,
  )

  cache.set(cacheKey, { snapshots, expiresAt: Date.now() + CACHE_TTL_MS })

  return NextResponse.json({
    snapshots,
    dateRange: { startDate, endDate },
    cachedAt: new Date().toISOString(),
  })
}
