import "server-only"
import { z } from "zod"
import { dfsRequest } from "@/lib/dataforseo"
import {
  buildGrid,
  computeKPIs,
  extractMapsItems,
  findTargetRank,
  MAX_GRID_DIM,
  MAX_SPACING_KM,
  MIN_GRID_DIM,
  MIN_SPACING_KM,
  rollupCompetitors,
  type MapsSerpItem,
} from "@/lib/gbp-heatmap"
import type { TaskContext, TaskRunner } from "@/lib/inngest/functions"
import { isCancelRequested, JobCancelledError, updateProgress } from "@/lib/jobs"
import { dfsCost } from "@/lib/tool-route"

/**
 * GBP Heatmap — large geo-grid scan as a background job.
 *
 * The synchronous route (`/api/tools/local/gbp-heatmap`) handles business
 * resolution, disambiguation, and small grids (≤ SYNC_MAX_POINTS) inline.
 * Anything bigger is dispatched here so it isn't capped by the route's 300s
 * budget. By the time this task runs the business is already resolved — the
 * route passes the resolved `target` (place_id + center) in the job input, so
 * there's no second my_business_info call and no disambiguation to handle.
 *
 * The scan is chunked across `step.run` batches so cumulative wall-clock can
 * exceed a single Vercel invocation's ceiling (Inngest re-invokes between
 * steps). Each batch returns a *slim* projection of the Maps SERP items it
 * saw — only the fields the rollup needs — to stay well under Inngest's
 * per-step output limit even on a 441-point grid.
 */

const TargetSchema = z.object({
  title: z.string(),
  place_id: z.string().nullable(),
  lat: z.number(),
  lng: z.number(),
  rating: z.number().nullable().default(null),
  rating_count: z.number().nullable().default(null),
  address: z.string().nullable().default(null),
  category: z.string().nullable().default(null),
})

const InputSchema = z.object({
  keyword: z.string().min(1),
  language_code: z.string().default("en"),
  grid_rows: z.number().int().min(MIN_GRID_DIM).max(MAX_GRID_DIM),
  grid_cols: z.number().int().min(MIN_GRID_DIM).max(MAX_GRID_DIM),
  spacing_km: z.number().min(MIN_SPACING_KM).max(MAX_SPACING_KM),
  target: TargetSchema,
})

const MAPS_SERP_ENDPOINT = "/v3/serp/google/maps/live/advanced"
const MAPS_DEPTH = 100
const MAPS_CONCURRENCY = 10
const MAPS_ZOOM = "12z"
// Points scanned per step.run. One concurrency wave per step keeps each
// Inngest step short (so a slow DataForSEO response can't push a single
// invocation toward the function ceiling) and lets progress advance every
// BATCH_POINTS rather than freezing for a third of the scan at a time.
const BATCH_POINTS = MAPS_CONCURRENCY
// Only the top-ranked businesses at each vantage point feed the competitor
// rollup. The sidebar surfaces the 20 strongest competitors across the grid,
// so a business sitting at rank 70 at one point is noise — and dropping it
// keeps the per-step output (and the total memoized run state on a 441-point
// grid) comfortably under Inngest's limits. The TARGET's rank is read from
// the full result first, so this cap never hides the scanned business itself.
const COMPETITOR_RANK_CUTOFF = 20

/**
 * Minimal MapsSerpItem projection. Structurally assignable to MapsSerpItem
 * (all those fields are optional there), so it can be passed straight to
 * `findTargetRank` / `rollupCompetitors`. Rank is collapsed into
 * `rank_absolute` — both helpers read `rank_absolute ?? rank_group`.
 */
interface SlimItem {
  rank_absolute: number | null
  title: string | null
  place_id: string | null
  rating: { value: number | null; votes_count: number | null } | null
  address: string | null
  latitude: number | null
  longitude: number | null
}

function slim(it: MapsSerpItem): SlimItem {
  return {
    rank_absolute: it.rank_absolute ?? it.rank_group ?? null,
    title: it.title ?? null,
    place_id: it.place_id ?? null,
    rating: it.rating
      ? {
          value: it.rating.value ?? null,
          votes_count: it.rating.votes_count ?? null,
        }
      : null,
    address: it.address ?? null,
    latitude: typeof it.latitude === "number" ? it.latitude : null,
    longitude: typeof it.longitude === "number" ? it.longitude : null,
  }
}

type ScannedPoint = {
  row: number
  col: number
  lat: number
  lng: number
  rank: number | null
  /** Total Maps results seen at this point (before the competitor cap). */
  foundCount: number
  items: SlimItem[]
}

async function mapWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results: U[] = new Array(items.length)
  let next = 0
  const workerCount = Math.min(concurrency, items.length)
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}

export const runGbpHeatmapTask: TaskRunner = async ({
  jobId,
  job,
  step,
}: TaskContext) => {
  const parsed = InputSchema.safeParse(job.input)
  if (!parsed.success) {
    throw new Error(
      `Invalid GBP heatmap input: ${JSON.stringify(parsed.error.flatten())}`,
    )
  }
  const { keyword, language_code, grid_rows, grid_cols, spacing_km, target } =
    parsed.data

  const checkCancel = async () => {
    if (await isCancelRequested(jobId)) throw new JobCancelledError(jobId)
  }

  const gridPoints = buildGrid(
    target.lat,
    target.lng,
    grid_rows,
    grid_cols,
    spacing_km,
  )
  const total = gridPoints.length
  const numBatches = Math.ceil(total / BATCH_POINTS)

  const scanned: ScannedPoint[] = []
  let costUsd = 0

  for (let b = 0; b < numBatches; b++) {
    const start = b * BATCH_POINTS
    const slice = gridPoints.slice(start, start + BATCH_POINTS)
    const batch = await step.run(`scan-${b}`, async () => {
      await checkCancel()
      // `start` = points already completed before this batch, so the bar
      // reflects real progress instead of jumping ahead to the batch's end.
      await updateProgress(jobId, {
        stage: "Scanning vantage points",
        detail: `${start} / ${total}`,
        percent: Math.round((start / total) * 100),
      }).catch(() => {})

      const points = await mapWithConcurrency(
        slice,
        MAPS_CONCURRENCY,
        async (pt) => {
          const env = await dfsRequest(MAPS_SERP_ENDPOINT, [
            {
              keyword,
              location_coordinate: `${pt.lat.toFixed(6)},${pt.lng.toFixed(6)},${MAPS_ZOOM}`,
              language_code,
              depth: MAPS_DEPTH,
            },
          ]).catch(() => null)
          const items = env ? extractMapsItems(env).map(slim) : []
          // Read the target's rank from the full result, then keep only the
          // top-ranked rows for the competitor rollup (see cutoff comment).
          const rank = findTargetRank(items, target.place_id, target.title)
          const competitorItems = items.filter(
            (it) =>
              it.rank_absolute != null &&
              it.rank_absolute <= COMPETITOR_RANK_CUTOFF,
          )
          return {
            row: pt.row,
            col: pt.col,
            lat: pt.lat,
            lng: pt.lng,
            rank,
            foundCount: items.length,
            items: competitorItems,
            cost: dfsCost(env),
          }
        },
      )

      const cost = points.reduce((sum, p) => sum + p.cost, 0)
      const scannedPoints: ScannedPoint[] = points.map((p) => ({
        row: p.row,
        col: p.col,
        lat: p.lat,
        lng: p.lng,
        rank: p.rank,
        foundCount: p.foundCount,
        items: p.items,
      }))
      return { points: scannedPoints, cost }
    })
    scanned.push(...batch.points)
    costUsd += batch.cost
  }

  // Aggregate. `scanned` is in global grid order (batches concatenated in
  // order), so competitor rank arrays line up with the points array.
  const points = scanned.map((s) => ({
    row: s.row,
    col: s.col,
    lat: s.lat,
    lng: s.lng,
    rank: s.rank,
    found_count: s.foundCount,
  }))
  const kpis = computeKPIs(points)
  const competitors = rollupCompetitors(
    scanned.map((s) => s.items),
    target.place_id,
    target.title,
    20,
  )

  const totalCost = Number(costUsd.toFixed(4))
  const durationSeconds = Math.max(
    0,
    Math.round((Date.now() - new Date(job.created_at).getTime()) / 1000),
  )

  console.log(
    `[gbp-heatmap:done] job=${jobId} points=${total} cost=$${totalCost.toFixed(2)} duration=${durationSeconds}s`,
  )

  const result = {
    status: "ok" as const,
    target,
    grid: {
      rows: grid_rows,
      cols: grid_cols,
      spacing_km,
      points,
    },
    kpis: {
      total: kpis.total,
      found: kpis.found,
      avg_rank: kpis.avgRank,
      sov_percent: kpis.sovPercent,
      good: kpis.good,
      average: kpis.average,
      poor: kpis.poor,
      oot20: kpis.oot20,
    },
    competitors: competitors.map((c) => ({
      title: c.title,
      place_id: c.place_id,
      rating: c.rating,
      rating_count: c.rating_count,
      lat: c.lat,
      lng: c.lng,
      address: c.address,
      avg_rank: c.avgRank,
      appearances: c.appearances,
      ranks: c.ranks,
    })),
    endpoints_called: [MAPS_SERP_ENDPOINT],
    costUsd: totalCost,
    durationSeconds,
  }

  return { result, resultPath: `/local/gbp-heatmap?job=${jobId}` }
}
