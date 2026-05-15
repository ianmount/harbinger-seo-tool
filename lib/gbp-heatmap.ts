/**
 * Pure helpers for the GBP Heatmap tool.
 *
 * Three responsibilities:
 *   1. Generate the geographic grid (5x7 by default, 1km spacing) around a
 *      center lat/lng so the API route can dispatch one Google Maps SERP
 *      call per point.
 *   2. Extract the target business's rank from a single Maps SERP envelope
 *      by matching place_id.
 *   3. Aggregate ranks across all grid points into KPIs (avg rank, share of
 *      voice, Good/Average/Poor/OOT20 buckets) and a competitor rollup
 *      (every other business seen across the grid, with avg rank and
 *      appearance count) for the sidebar.
 *
 * All bucket thresholds match the mock spec:
 *   Good     = rank 1-3
 *   Average  = rank 4-10
 *   Poor     = rank 11-20
 *   OOT20    = rank > 20 OR not found
 */

export interface GridPointInput {
  row: number
  col: number
  lat: number
  lng: number
}

export interface GridPointResult extends GridPointInput {
  rank: number | null
}

export interface HeatmapKPIs {
  total: number
  found: number
  avgRank: number | null
  sovPercent: number
  good: number
  average: number
  poor: number
  oot20: number
}

export interface CompetitorRow {
  title: string
  place_id: string | null
  rating: number | null
  rating_count: number | null
  avgRank: number
  appearances: number
}

const KM_PER_DEG_LAT = 111.0

export function buildGrid(
  centerLat: number,
  centerLng: number,
  rows = 5,
  cols = 7,
  spacingKm = 1,
): GridPointInput[] {
  const points: GridPointInput[] = []
  const latStep = spacingKm / KM_PER_DEG_LAT
  const lngStep =
    spacingKm / (KM_PER_DEG_LAT * Math.cos((centerLat * Math.PI) / 180))
  const rowMid = (rows - 1) / 2
  const colMid = (cols - 1) / 2
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Row 0 is the northernmost row → larger latitude.
      const lat = centerLat + (rowMid - r) * latStep
      const lng = centerLng + (c - colMid) * lngStep
      points.push({ row: r, col: c, lat, lng })
    }
  }
  return points
}

/**
 * Shape of a single Maps SERP item we care about. DFSEO returns more
 * fields; we only validate the ones we use.
 */
export interface MapsSerpItem {
  type?: string | null
  rank_absolute?: number | null
  rank_group?: number | null
  title?: string | null
  place_id?: string | null
  rating?: { value?: number | null; votes_count?: number | null } | null
  address?: string | null
  cid?: string | null
}

export function extractMapsItems(envelope: unknown): MapsSerpItem[] {
  const env = envelope as {
    tasks?: { result?: { items?: unknown[] }[] | null }[]
  } | null
  if (!env?.tasks) return []
  const out: MapsSerpItem[] = []
  for (const task of env.tasks) {
    for (const r of task.result ?? []) {
      for (const item of r.items ?? []) {
        if (item && typeof item === "object") {
          out.push(item as MapsSerpItem)
        }
      }
    }
  }
  return out
}

/**
 * Find the target business's rank in a single Maps SERP envelope. Matches
 * by place_id first (most reliable), falls back to case-insensitive title
 * match because DFSEO occasionally omits place_id on a row.
 */
export function findTargetRank(
  items: MapsSerpItem[],
  targetPlaceId: string | null,
  targetTitle: string | null,
): number | null {
  if (targetPlaceId) {
    for (const item of items) {
      if (item.place_id && item.place_id === targetPlaceId) {
        return item.rank_absolute ?? item.rank_group ?? null
      }
    }
  }
  if (targetTitle) {
    const needle = targetTitle.toLowerCase()
    for (const item of items) {
      if (item.title && item.title.toLowerCase() === needle) {
        return item.rank_absolute ?? item.rank_group ?? null
      }
    }
  }
  return null
}

export type RankBucket = "good" | "average" | "poor" | "oot20"

export function bucketRank(rank: number | null): RankBucket {
  if (rank == null) return "oot20"
  if (rank <= 3) return "good"
  if (rank <= 10) return "average"
  if (rank <= 20) return "poor"
  return "oot20"
}

export function computeKPIs(points: readonly GridPointResult[]): HeatmapKPIs {
  let good = 0
  let average = 0
  let poor = 0
  let oot20 = 0
  let rankSum = 0
  let found = 0
  for (const p of points) {
    switch (bucketRank(p.rank)) {
      case "good":
        good++
        break
      case "average":
        average++
        break
      case "poor":
        poor++
        break
      case "oot20":
        oot20++
        break
    }
    if (typeof p.rank === "number") {
      rankSum += p.rank
      found++
    }
  }
  const total = points.length
  return {
    total,
    found,
    avgRank: found > 0 ? rankSum / found : null,
    sovPercent: total > 0 ? (good / total) * 100 : 0,
    good,
    average,
    poor,
    oot20,
  }
}

/**
 * Roll competitor appearances up across all grid points. Each non-target
 * business that appears in any grid point's top-N is counted; we surface
 * the top 20 by average rank.
 *
 * Title is used as the dedupe key when place_id is missing, since DFSEO
 * sometimes returns the same business under different rows without a
 * place_id (e.g. paid placements).
 */
export function rollupCompetitors(
  gridItemsByPoint: readonly MapsSerpItem[][],
  targetPlaceId: string | null,
  targetTitle: string | null,
  limit = 20,
): CompetitorRow[] {
  type Acc = {
    title: string
    place_id: string | null
    rating: number | null
    rating_count: number | null
    rankSum: number
    appearances: number
  }
  const map = new Map<string, Acc>()
  const targetTitleLower = targetTitle?.toLowerCase() ?? null

  for (const items of gridItemsByPoint) {
    for (const item of items) {
      const place_id = item.place_id ?? null
      const title = item.title ?? null
      if (!title) continue
      // Skip the target business itself.
      if (targetPlaceId && place_id === targetPlaceId) continue
      if (
        targetTitleLower &&
        title.toLowerCase() === targetTitleLower
      )
        continue
      const rank = item.rank_absolute ?? item.rank_group ?? null
      if (rank == null) continue
      const key = place_id ?? `title:${title.toLowerCase()}`
      const existing = map.get(key)
      if (existing) {
        existing.rankSum += rank
        existing.appearances += 1
      } else {
        map.set(key, {
          title,
          place_id,
          rating: item.rating?.value ?? null,
          rating_count: item.rating?.votes_count ?? null,
          rankSum: rank,
          appearances: 1,
        })
      }
    }
  }

  const rows: CompetitorRow[] = []
  for (const acc of map.values()) {
    rows.push({
      title: acc.title,
      place_id: acc.place_id,
      rating: acc.rating,
      rating_count: acc.rating_count,
      avgRank: acc.rankSum / acc.appearances,
      appearances: acc.appearances,
    })
  }
  rows.sort((a, b) => {
    // Prefer broader coverage first, then better average rank.
    if (b.appearances !== a.appearances) return b.appearances - a.appearances
    return a.avgRank - b.avgRank
  })
  return rows.slice(0, limit)
}

/**
 * Hex color for a rank bucket. Matches the mock palette.
 */
export function rankColor(rank: number | null): string {
  if (rank == null) return "#9D9D9D"
  if (rank <= 3) return "#0F6E56"
  if (rank <= 10) return "#EF9F27"
  if (rank <= 20) return "#D85A30"
  return "#9D9D9D"
}
