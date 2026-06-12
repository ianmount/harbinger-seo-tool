import { z } from "zod"
import {
  buildGrid,
  computeKPIs,
  CUSTOM_MAX_POINTS,
  extractMapsItems,
  findTargetRank,
  MAX_GRID_DIM,
  MAX_SPACING_KM,
  MIN_GRID_DIM,
  MIN_SPACING_KM,
  rollupCompetitors,
  SYNC_MAX_POINTS,
  type GridPointResult,
  type MapsSerpItem,
} from "@/lib/gbp-heatmap"
import {
  dfsCost,
  dfsItems,
  locationFields,
  runTool,
} from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const Input = z.object({
  business: z.string().min(1),
  keyword: z.string().min(1),
  location_code: z.number().int().optional(),
  location_name: z.string().optional(),
  language_code: z.string().default("en"),
  grid_rows: z.number().int().min(MIN_GRID_DIM).max(MAX_GRID_DIM).default(5),
  grid_cols: z.number().int().min(MIN_GRID_DIM).max(MAX_GRID_DIM).default(7),
  spacing_km: z.number().min(MIN_SPACING_KM).max(MAX_SPACING_KM).default(1),
  // When set, the resolution step is skipped and the scan runs directly
  // against the supplied center. Used after the user picks one of the
  // disambiguation candidates from a prior call.
  place_id: z.string().optional(),
  center_lat: z.number().optional(),
  center_lng: z.number().optional(),
  business_title: z.string().optional(),
  // Resolve the business and return the target/candidates without scanning.
  // Used by the custom-area flow to center the map before the user draws.
  resolve_only: z.boolean().optional(),
  // Custom-area mode: an explicit list of vantage points to scan (drawn on the
  // map). When present, the rectangular grid is ignored. Capped to keep cost
  // bounded; the UI enforces the same cap before sending.
  points: z
    .array(z.object({ lat: z.number(), lng: z.number() }))
    .min(1)
    .max(CUSTOM_MAX_POINTS)
    .optional(),
  radius_miles: z.number().optional(),
})

type Status = "ok" | "ambiguous" | "not_found"

type ResolvedTarget = {
  title: string
  address: string | null
  place_id: string | null
  lat: number
  lng: number
  rating: number | null
  rating_count: number | null
  category: string | null
}

type Candidate = {
  title: string
  address: string | null
  place_id: string | null
  lat: number | null
  lng: number | null
  rating: number | null
  rating_count: number | null
  category: string | null
}

type Point = GridPointResult & { found_count: number }

type Competitor = {
  title: string
  place_id: string | null
  rating: number | null
  rating_count: number | null
  lat: number | null
  lng: number | null
  address: string | null
  avg_rank: number
  appearances: number
  ranks: (number | null)[]
}

type Data = {
  status: Status
  /**
   * Set when the grid exceeds SYNC_MAX_POINTS. The route resolves the business
   * (so the caller gets `target`) but does NOT scan — the client starts a
   * background job with the resolved target instead. `grid`/`kpis`/
   * `competitors` are absent in this case.
   */
  requires_job?: boolean
  target?: ResolvedTarget
  candidates?: Candidate[]
  grid?: {
    rows: number
    cols: number
    spacing_km: number
    points: Point[]
    /** Custom-drawn area instead of a rectangular grid (no row/col layout). */
    custom?: boolean
    radius_miles?: number
  }
  kpis?: {
    total: number
    found: number
    avg_rank: number | null
    sov_percent: number
    good: number
    average: number
    poor: number
    oot20: number
  }
  competitors?: Competitor[]
  endpoints_called: string[]
}

const BUSINESS_INFO_ENDPOINT = "/v3/business_data/google/my_business_info/live"
const MAPS_SERP_ENDPOINT = "/v3/serp/google/maps/live/advanced"
const MAPS_DEPTH = 100
const MAPS_CONCURRENCY = 16
// Maps SERP wants the searcher's location as "lat,lng,radius_km" or
// "lat,lng,zoom". The zoom format with a trailing `z` is the canonical
// "simulate a Google Maps user zoomed in to street level" form.
const MAPS_ZOOM = "12z"

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

type BusinessInfoItem = {
  title?: string | null
  address?: string | null
  place_id?: string | null
  latitude?: number | null
  longitude?: number | null
  rating?: { value?: number | null; votes_count?: number | null } | null
  category?: string | null
}

function toCandidate(it: BusinessInfoItem): Candidate {
  return {
    title: it.title ?? "",
    address: it.address ?? null,
    place_id: it.place_id ?? null,
    lat: typeof it.latitude === "number" ? it.latitude : null,
    lng: typeof it.longitude === "number" ? it.longitude : null,
    rating: it.rating?.value ?? null,
    rating_count: it.rating?.votes_count ?? null,
    category: it.category ?? null,
  }
}

function toResolved(c: Candidate): ResolvedTarget | null {
  if (c.lat == null || c.lng == null) return null
  return {
    title: c.title,
    address: c.address,
    place_id: c.place_id,
    lat: c.lat,
    lng: c.lng,
    rating: c.rating,
    rating_count: c.rating_count,
    category: c.category,
  }
}

export async function POST(request: Request) {
  return runTool<typeof Input, Data>(request, Input, async (input, { dfs }) => {
    const loc = locationFields(input)
    const endpointsCalled: string[] = []

    // Branch 1: user has already picked a target (place_id + lat/lng
    // supplied). Skip the my_business_info resolution call entirely.
    let resolved: ResolvedTarget | null = null
    let resolveCost = 0
    if (input.place_id && input.center_lat != null && input.center_lng != null) {
      resolved = {
        title: input.business_title ?? input.business,
        address: null,
        place_id: input.place_id,
        lat: input.center_lat,
        lng: input.center_lng,
        rating: null,
        rating_count: null,
        category: null,
      }
    } else {
      // Branch 2: resolve the business name against DFSEO's GBP database.
      const businessEnv = await dfs(BUSINESS_INFO_ENDPOINT, [
        { keyword: input.business, ...loc, limit: 5 },
      ]).catch(() => null)
      endpointsCalled.push(BUSINESS_INFO_ENDPOINT)
      resolveCost = dfsCost(businessEnv)

      const items = businessEnv ? dfsItems<BusinessInfoItem>(businessEnv) : []
      const candidates = items.map(toCandidate)
      // Only keep candidates with coords — DFSEO sometimes returns rows
      // with a title but no lat/lng; those can't anchor a grid.
      const placeable = candidates.filter(
        (c) => typeof c.lat === "number" && typeof c.lng === "number",
      )

      if (placeable.length === 0) {
        return {
          data: {
            status: "not_found",
            candidates,
            endpoints_called: endpointsCalled,
          },
          endpoints: endpointsCalled,
          costUsd: resolveCost,
        }
      }

      if (placeable.length > 1) {
        return {
          data: {
            status: "ambiguous",
            candidates: placeable,
            endpoints_called: endpointsCalled,
          },
          endpoints: endpointsCalled,
          costUsd: resolveCost,
        }
      }

      resolved = toResolved(placeable[0])
    }

    if (!resolved) {
      return {
        data: {
          status: "not_found",
          candidates: [],
          endpoints_called: endpointsCalled,
        },
        endpoints: endpointsCalled,
        costUsd: resolveCost,
      }
    }

    // Resolve-only: the custom-area flow needs the business center to draw the
    // circle on the map before any scanning. Return the target and stop.
    if (input.resolve_only) {
      return {
        data: {
          status: "ok",
          target: resolved,
          endpoints_called: endpointsCalled,
        },
        endpoints: endpointsCalled,
        costUsd: resolveCost,
      }
    }

    // Custom-area mode scans an explicit point list; otherwise build the grid.
    const isCustom = Array.isArray(input.points) && input.points.length > 0
    const pointCount = isCustom
      ? input.points!.length
      : input.grid_rows * input.grid_cols

    // Anything beyond the synchronous budget is handed back so the client can
    // kick off a background job. The resolution cost is still charged; the job
    // skips re-resolution by accepting `place_id` + center.
    if (pointCount > SYNC_MAX_POINTS) {
      return {
        data: {
          status: "ok",
          requires_job: true,
          target: resolved,
          grid: {
            rows: isCustom ? 0 : input.grid_rows,
            cols: isCustom ? 0 : input.grid_cols,
            spacing_km: isCustom ? 0 : input.spacing_km,
            points: [],
            custom: isCustom,
            radius_miles: input.radius_miles,
          },
          endpoints_called: endpointsCalled,
        },
        endpoints: endpointsCalled,
        costUsd: resolveCost,
      }
    }

    // Branch 3: scan. Fire one Maps SERP call per vantage point in parallel,
    // then aggregate. Each call costs ~$0.003.
    const gridPoints: { row: number; col: number; lat: number; lng: number }[] =
      isCustom
      ? input.points!.map((p, i) => ({
          row: 0,
          col: i,
          lat: p.lat,
          lng: p.lng,
        }))
      : buildGrid(
          resolved.lat,
          resolved.lng,
          input.grid_rows,
          input.grid_cols,
          input.spacing_km,
        )

    type ScanResult = {
      point: { row: number; col: number; lat: number; lng: number }
      items: MapsSerpItem[]
      cost: number
    }

    const scans = await mapWithConcurrency(gridPoints, MAPS_CONCURRENCY, async (pt) => {
      const env = await dfs(MAPS_SERP_ENDPOINT, [
        {
          keyword: input.keyword,
          location_coordinate: `${pt.lat.toFixed(6)},${pt.lng.toFixed(6)},${MAPS_ZOOM}`,
          language_code: input.language_code,
          depth: MAPS_DEPTH,
        },
      ]).catch(() => null)
      return {
        point: pt,
        items: env ? extractMapsItems(env) : [],
        cost: dfsCost(env),
      } satisfies ScanResult
    })
    endpointsCalled.push(MAPS_SERP_ENDPOINT)

    const points: Point[] = scans.map((s) => ({
      row: s.point.row,
      col: s.point.col,
      lat: s.point.lat,
      lng: s.point.lng,
      rank: findTargetRank(s.items, resolved.place_id, resolved.title),
      found_count: s.items.length,
    }))

    const kpis = computeKPIs(points)
    const competitors = rollupCompetitors(
      scans.map((s) => s.items),
      resolved.place_id,
      resolved.title,
      20,
    )

    const totalCost = resolveCost + scans.reduce((sum, s) => sum + s.cost, 0)

    return {
      data: {
        status: "ok",
        target: resolved,
        grid: {
          rows: isCustom ? 0 : input.grid_rows,
          cols: isCustom ? 0 : input.grid_cols,
          spacing_km: isCustom ? 0 : input.spacing_km,
          points,
          custom: isCustom,
          radius_miles: input.radius_miles,
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
        endpoints_called: endpointsCalled,
      },
      endpoints: endpointsCalled,
      costUsd: totalCost,
    }
  })
}
