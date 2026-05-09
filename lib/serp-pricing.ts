/**
 * SERP cost estimator shared between the comp-analysis task (server) and
 * the comp-analysis page (client). Lives outside `lib/tasks/` because the
 * page can't import server-only modules.
 *
 * The estimate is a coarse approximation of DataForSEO's /v3/serp/google/
 * organic/live/advanced pricing — verified ground truth comes from the
 * `cost` field on the response envelope (recorded into the per-job
 * accumulator and surfaced as `dfsActualCostUsd`). These numbers exist only
 * to set expectations in the UI before kicking off a run.
 */

export const SERP_DEPTH_OPTIONS = [20, 30, 100] as const
export type SerpDepth = (typeof SERP_DEPTH_OPTIONS)[number]
export const DEFAULT_SERP_DEPTH: SerpDepth = 100

export function isSerpDepth(v: unknown): v is SerpDepth {
  return (SERP_DEPTH_OPTIONS as readonly number[]).includes(v as number)
}

/**
 * Per-call USD estimate for /v3/serp/google/organic/live/advanced. Pulled
 * from DataForSEO's published pricing — depth ≤ 30 is significantly cheaper
 * than depth 100 because the response payload (and therefore the cost) scales
 * with the number of organic results returned. Update if pricing changes.
 */
export function estimateSerpCostPerCall(depth: SerpDepth): number {
  switch (depth) {
    case 20:
      return 0.0011
    case 30:
      return 0.0017
    case 100:
      return 0.003
  }
}

export function describeSerpDepth(depth: SerpDepth): string {
  switch (depth) {
    case 20:
      return "Top 20 — cheapest. Loses Top 100 bucket."
    case 30:
      return "Top 30 — covers Top 3 / 10 / 20. Loses Top 100 bucket."
    case 100:
      return "Top 100 — full visibility. ~3× the cost of Top 20."
  }
}
