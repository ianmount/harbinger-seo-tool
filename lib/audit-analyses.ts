import type {
  AuditGscAnalyses,
  GSCQueryRow,
  GSCTopPageRow,
  GSCTopQueryRow,
  MegaImpressionHub,
  ObservedCtrTier,
  PositionBand,
  PowerPageConcentration,
  QuickWinQuery,
} from "@/lib/types"

/**
 * Pure, server-only analysis helpers that turn raw GSC exports into the
 * structured tables the audit prompt and PDF expect. No I/O — just math
 * over arrays. Pulled into its own module so the audit pipeline can call
 * these helpers directly and so they're trivially unit-testable.
 *
 * Calibration philosophy: the partner's OWN observed CTR at top-3 is the
 * baseline for every uplift estimate. Industry CTR averages are not used.
 * AI Overview suppression makes high-impression queries earn lower CTRs at
 * top-3 than older studies suggest, and the calibration captures that for
 * THIS partner's actual SERP environment without us having to model AIO
 * presence directly.
 */

// ──────────────────────────────────────────────────────────────────────────
// Position distribution.

const POSITION_BAND_DEFS: ReadonlyArray<{
  band: string
  positionMin: number
  positionMax: number
}> = [
  { band: "1–3", positionMin: 1, positionMax: 3 },
  { band: "4–10", positionMin: 4, positionMax: 10 },
  { band: "11–20", positionMin: 11, positionMax: 20 },
  { band: "21–50", positionMin: 21, positionMax: 50 },
]

/**
 * Roll up query rows into position bands. We use the avg position GSC
 * returns; rows with position > 50 fall outside all bands and are ignored.
 */
export function buildPositionDistribution(
  queries: ReadonlyArray<GSCTopQueryRow>,
): PositionBand[] {
  return POSITION_BAND_DEFS.map((def) => {
    let queryCount = 0
    let clicks = 0
    let impressions = 0
    for (const q of queries) {
      const pos = q.position
      if (pos < def.positionMin || pos > def.positionMax) continue
      queryCount += 1
      clicks += q.clicks
      impressions += q.impressions
    }
    const ctr = impressions > 0 ? clicks / impressions : 0
    return {
      band: def.band,
      positionMin: def.positionMin,
      positionMax: def.positionMax,
      queryCount,
      clicks,
      impressions,
      ctr,
    }
  })
}

// ──────────────────────────────────────────────────────────────────────────
// Observed CTR benchmarks per impression tier.

const IMPRESSION_TIERS: ReadonlyArray<{
  tier: string
  impressionMin: number
  impressionMax: number | null
}> = [
  { tier: "<100", impressionMin: 0, impressionMax: 99 },
  { tier: "100–1K", impressionMin: 100, impressionMax: 999 },
  { tier: "1K–10K", impressionMin: 1_000, impressionMax: 9_999 },
  { tier: "10K+", impressionMin: 10_000, impressionMax: null },
]

const MIN_TIER_SAMPLE = 5

function median(values: ReadonlyArray<number>): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

/**
 * Compute the partner's OWN observed CTR at positions 1–3 by impression
 * tier. We deliberately do NOT filter by brand/non-brand here — detecting
 * a partner's brand mention in a query is unreliable, and most local
 * service partners don't get enough branded query volume for it to skew
 * the calibration meaningfully. If a partner does have a strong brand,
 * the tier means will be inflated and the audit will under-promise on
 * uplift, which is the safer error.
 *
 * Pass the 90-day GSC top-queries window — the recent slice keeps the
 * baseline aligned with current SERP behavior (AI Overviews etc.).
 */
export function buildObservedCtrTiers(
  recentTopQueries: ReadonlyArray<GSCTopQueryRow>,
): ObservedCtrTier[] {
  const topThree = recentTopQueries.filter(
    (q) => q.position >= 1 && q.position <= 3 && q.impressions > 0,
  )
  return IMPRESSION_TIERS.map((def) => {
    const inTier = topThree.filter(
      (q) =>
        q.impressions >= def.impressionMin &&
        (def.impressionMax === null || q.impressions <= def.impressionMax),
    )
    const ctrs = inTier.map((q) => q.ctr)
    const meanCtr =
      ctrs.length > 0 ? ctrs.reduce((s, v) => s + v, 0) / ctrs.length : 0
    return {
      tier: def.tier,
      impressionMin: def.impressionMin,
      impressionMax: def.impressionMax,
      queryCount: inTier.length,
      meanCtr,
      medianCtr: median(ctrs),
      lowConfidence: inTier.length < MIN_TIER_SAMPLE,
    }
  })
}

/**
 * Conservative fallback CTRs for tiers with too few observations. These are
 * intentionally lower than older industry studies (Backlinko, Sistrix) to
 * reflect AI Overview suppression on high-impression queries. When the
 * tier has enough samples we always use the partner's own number instead.
 */
const FALLBACK_TOP3_CTRS: Record<string, number> = {
  "<100": 0.35,
  "100–1K": 0.22,
  "1K–10K": 0.12,
  "10K+": 0.06,
}

function ctrForTier(tier: ObservedCtrTier): number {
  if (tier.lowConfidence) {
    return FALLBACK_TOP3_CTRS[tier.tier] ?? 0.1
  }
  // Use the median, not the mean — robust to one or two outliers per tier.
  return tier.medianCtr > 0 ? tier.medianCtr : tier.meanCtr
}

function matchTier(
  impressions: number,
  tiers: ReadonlyArray<ObservedCtrTier>,
): ObservedCtrTier {
  for (const t of tiers) {
    if (
      impressions >= t.impressionMin &&
      (t.impressionMax === null || impressions <= t.impressionMax)
    ) {
      return t
    }
  }
  return tiers[tiers.length - 1]
}

// ──────────────────────────────────────────────────────────────────────────
// Quick-win queries.

/**
 * Pull queries currently in positions 4–10 with enough impression volume
 * to make a top-3 move worth chasing. Sorted by projected click uplift.
 *
 * `windowMonths` lets the caller tell us how many months the queries cover
 * so we can annualize correctly. For a 16-month export, multiplier is 12/16
 * (≈0.75); for a 12-month export it's 1.0; for 90-day it's 12/3 (≈4).
 */
export function buildQuickWins(params: {
  longRangeQueries: ReadonlyArray<GSCTopQueryRow>
  /** When this is a query-page export, we can attach the page URL. */
  longRangeQueryPages?: ReadonlyArray<GSCQueryRow>
  observedCtrTiers: ReadonlyArray<ObservedCtrTier>
  windowMonths: number
  limit?: number
  /** Minimum impressions in the window to be considered. Default 200. */
  minImpressions?: number
}): QuickWinQuery[] {
  const minImpressions = params.minImpressions ?? 200
  const limit = params.limit ?? 15
  const annualMultiplier = 12 / Math.max(1, params.windowMonths)

  // Build a query → page map from the dimensions=[query,page] export when
  // present, so each quick win comes with a recommended landing page. We
  // use the highest-impression page per query.
  const queryToPage = new Map<string, string>()
  if (params.longRangeQueryPages) {
    const best = new Map<string, { page: string; impressions: number }>()
    for (const r of params.longRangeQueryPages) {
      const cur = best.get(r.query)
      if (!cur || r.impressions > cur.impressions) {
        best.set(r.query, { page: r.page, impressions: r.impressions })
      }
    }
    for (const [q, v] of best.entries()) {
      queryToPage.set(q, v.page)
    }
  }

  const candidates = params.longRangeQueries
    .filter(
      (q) =>
        q.position >= 4 &&
        q.position <= 10 &&
        q.impressions >= minImpressions,
    )
    .map((q): QuickWinQuery => {
      const tier = matchTier(q.impressions, params.observedCtrTiers)
      const projectedTopThreeCtr = ctrForTier(tier)
      const annualImpressions = q.impressions * annualMultiplier
      const annualCurrentClicks = q.clicks * annualMultiplier
      const projectedAnnualClicks = annualImpressions * projectedTopThreeCtr
      return {
        query: q.query,
        page: queryToPage.get(q.query) ?? null,
        currentPosition: q.position,
        currentClicks: q.clicks,
        currentImpressions: q.impressions,
        currentCtr: q.ctr,
        matchedTier: tier.tier,
        projectedTopThreeCtr,
        projectedAnnualClicks,
        upliftAnnualClicks: Math.max(
          0,
          projectedAnnualClicks - annualCurrentClicks,
        ),
      }
    })
    .filter((q) => q.upliftAnnualClicks > 0)

  candidates.sort((a, b) => b.upliftAnnualClicks - a.upliftAnnualClicks)
  return candidates.slice(0, limit)
}

// ──────────────────────────────────────────────────────────────────────────
// Mega-impression hubs.

/**
 * Pages with 100K+ impressions and sub-2% CTR over the long range. Usually
 * the highest-ROI title/meta rewrite targets — a small CTR lift on a
 * massive impression base produces the biggest absolute click gains.
 *
 * Projected CTR is the partner's own calibrated top-3 CTR for the matched
 * impression tier — but capped at a realistic delta over current CTR so we
 * don't promise impossible jumps when AIO suppression is the real ceiling.
 */
export function buildMegaImpressionHubs(params: {
  longRangePages: ReadonlyArray<GSCTopPageRow>
  observedCtrTiers: ReadonlyArray<ObservedCtrTier>
  windowMonths: number
  /** Default 100,000. */
  minImpressions?: number
  /** Default 0.02 (= 2%). */
  maxCtr?: number
  limit?: number
}): MegaImpressionHub[] {
  const minImpressions = params.minImpressions ?? 100_000
  const maxCtr = params.maxCtr ?? 0.02
  const limit = params.limit ?? 10
  const annualMultiplier = 12 / Math.max(1, params.windowMonths)

  const candidates = params.longRangePages
    .filter((p) => p.impressions >= minImpressions && p.ctr < maxCtr)
    .map((p): MegaImpressionHub => {
      const tier = matchTier(p.impressions, params.observedCtrTiers)
      const tierCtr = ctrForTier(tier)
      // Don't promise a 5x CTR move on a page already getting any traffic;
      // cap the projected lift at +200% of current CTR or the tier baseline,
      // whichever is smaller. This keeps the audit honest about AIO.
      const cappedCtr = Math.min(tierCtr, Math.max(0.04, p.ctr * 3))
      const annualImpressions = p.impressions * annualMultiplier
      const projectedAnnualClicks = annualImpressions * cappedCtr
      const currentAnnualClicks = p.clicks * annualMultiplier
      return {
        page: p.page,
        clicks: p.clicks,
        impressions: p.impressions,
        ctr: p.ctr,
        position: p.position,
        projectedCtr: cappedCtr,
        projectedAdditionalClicks: Math.max(
          0,
          projectedAnnualClicks - currentAnnualClicks,
        ),
      }
    })

  candidates.sort(
    (a, b) => b.projectedAdditionalClicks - a.projectedAdditionalClicks,
  )
  return candidates.slice(0, limit)
}

// ──────────────────────────────────────────────────────────────────────────
// Power-page concentration.

const CONCENTRATION_BANDS = [9, 28, 200, 1000] as const

export function buildPageConcentration(
  pages: ReadonlyArray<GSCTopPageRow>,
): PowerPageConcentration {
  const sorted = [...pages].sort((a, b) => b.clicks - a.clicks)
  const totalClicks = sorted.reduce((s, p) => s + p.clicks, 0)
  const bands = CONCENTRATION_BANDS.map((topN) => {
    const slice = sorted.slice(0, topN)
    const clicks = slice.reduce((s, p) => s + p.clicks, 0)
    const sharePct = totalClicks > 0 ? (clicks / totalClicks) * 100 : 0
    return { topN, clicks, sharePct }
  })

  // Binary-search-ish: walk forward until cumulative clicks >= 50%.
  let pagesToHalfOfClicks = sorted.length
  let running = 0
  const halfTarget = totalClicks / 2
  for (let i = 0; i < sorted.length; i++) {
    running += sorted[i].clicks
    if (running >= halfTarget) {
      pagesToHalfOfClicks = i + 1
      break
    }
  }

  return {
    totalPages: sorted.length,
    totalClicks,
    bands,
    pagesToHalfOfClicks,
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Compose the full GSC analysis bundle.

export function buildGscAnalyses(params: {
  longRangeTopQueries: ReadonlyArray<GSCTopQueryRow>
  longRangeTopPages: ReadonlyArray<GSCTopPageRow>
  longRangeQueryPages?: ReadonlyArray<GSCQueryRow>
  recentTopQueries: ReadonlyArray<GSCTopQueryRow>
  longRangeMonths: number
}): AuditGscAnalyses {
  const positionDistribution = buildPositionDistribution(
    params.longRangeTopQueries,
  )
  const observedCtrTiers = buildObservedCtrTiers(params.recentTopQueries)
  const quickWins = buildQuickWins({
    longRangeQueries: params.longRangeTopQueries,
    longRangeQueryPages: params.longRangeQueryPages,
    observedCtrTiers,
    windowMonths: params.longRangeMonths,
  })
  const megaImpressionHubs = buildMegaImpressionHubs({
    longRangePages: params.longRangeTopPages,
    observedCtrTiers,
    windowMonths: params.longRangeMonths,
  })
  const pageConcentration = buildPageConcentration(params.longRangeTopPages)
  const totalClicksLongRange = params.longRangeTopPages.reduce(
    (s, p) => s + p.clicks,
    0,
  )
  const totalImpressionsLongRange = params.longRangeTopPages.reduce(
    (s, p) => s + p.impressions,
    0,
  )
  return {
    positionDistribution,
    observedCtrTiers,
    quickWins,
    megaImpressionHubs,
    pageConcentration,
    totalClicksLongRange,
    totalImpressionsLongRange,
  }
}
