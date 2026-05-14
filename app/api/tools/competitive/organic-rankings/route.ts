import { z } from "zod"
import { dfsCost, dfsItems, runTool } from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const CityInput = z.object({
  location_code: z.number().int(),
  location_name: z.string().min(1),
})

const Input = z.object({
  target: z.string().min(3),
  language_code: z.string().default("en"),
  // Cities are picked from the DFS Labs taxonomy on the client (via
  // LocationAutocomplete), so we get a validated location_code per city
  // and feed the SERP endpoint by code rather than name.
  cities: z.array(CityInput).default([]),
  limit: z.number().int().min(1).max(1000).default(250),
  kw_table_limit: z.number().int().min(1).max(50).default(20),
  city_kw_limit: z.number().int().min(0).max(15).default(5),
})

// Country-level US row. Labs endpoints accept country-name locations; the
// per-city SERP calls below take location_code from each selected city.
const US_LOCATION = { location_name: "United States", language_code: "en" }

type Kpis = {
  visibilityScore: number
  trackedKeywords: number
  cityCount: number
  avgPosition: number | null
  trafficValueUsd: number
  serpFeatures: number
}

type TrendPoint = { label: string; visibility: number }

type Mover = { keyword: string; from: number | null; to: number; delta: number }

type SerpFeatureRow = { type: string; label: string; count: number }

type IntentRow = { intent: string; count: number; pct: number }

type PageRow = {
  url: string
  keywords: number
  etv: number
  topKeyword: string | null
}

type KeywordRow = {
  keyword: string
  position: number
  delta: number | null
  volume: number | null
  kd: number | null
  intent: string | null
  url: string
}

type CitySerpRow = {
  keyword: string
  positions: Record<string, { pos: number | null; delta: number | null }>
}

type Data = {
  target: string
  market: string
  cities: string[]
  kpis: Kpis
  visibilityTrend: TrendPoint[]
  topGainers: Mover[]
  topLosers: Mover[]
  serpFeatures: SerpFeatureRow[]
  intent: IntentRow[]
  pages: PageRow[]
  keywords: KeywordRow[]
  citySerp: CitySerpRow[]
}

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const

// Standard organic CTR-by-position curve. Industry-aggregated benchmark, used
// to translate (position, search_volume) pairs into a single visibility score
// the way SEMRush/Ahrefs/Moz do. Long-tail positions get tiny but non-zero CTR
// so a domain ranking only on page 4+ still earns >0 visibility.
const CTR: Record<number, number> = {
  1: 0.318,
  2: 0.155,
  3: 0.099,
  4: 0.072,
  5: 0.054,
  6: 0.041,
  7: 0.034,
  8: 0.029,
  9: 0.025,
  10: 0.022,
}
function ctrFor(pos: number | null | undefined): number {
  if (!pos || pos < 1) return 0
  if (pos <= 10) return CTR[pos] ?? 0
  if (pos <= 20) return 0.012
  if (pos <= 30) return 0.006
  if (pos <= 50) return 0.003
  if (pos <= 100) return 0.001
  return 0
}

// Human-readable labels for the SERP feature types DFS returns under
// serp_item.type. Keys we don't recognize fall through to a Title-Cased
// version of the snake_case key.
const SERP_FEATURE_LABELS: Record<string, string> = {
  local_pack: "Local pack",
  people_also_ask: "People also ask",
  related_searches: "Related searches",
  images: "Image pack",
  image: "Image pack",
  faq: "FAQ",
  faq_box: "FAQ",
  sitelinks: "Sitelinks",
  featured_snippet: "Featured snippet",
  knowledge_graph: "Knowledge graph",
  video: "Video",
  videos: "Video",
  shopping: "Shopping",
  twitter: "Twitter",
  top_stories: "Top stories",
  answer_box: "Answer box",
  organic: "Organic",
}
function serpFeatureLabel(key: string): string {
  if (SERP_FEATURE_LABELS[key]) return SERP_FEATURE_LABELS[key]
  return key
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
}

const INTENT_ORDER = [
  "informational",
  "navigational",
  "commercial",
  "transactional",
] as const

function stripDomain(domain: string): string {
  return domain
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase()
}

function rootDomain(d: string): string {
  return d.replace(/^https?:\/\//i, "").replace(/^www\./, "").replace(/\/.*$/, "").toLowerCase()
}

// 13 months back so the trailing-12 slice has 12 complete months even when
// the current month is partially elapsed.
function historicalDateFrom(): string {
  const d = new Date()
  d.setUTCMonth(d.getUTCMonth() - 13)
  d.setUTCDate(1)
  return d.toISOString().slice(0, 10)
}
function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export async function POST(request: Request) {
  return runTool<typeof Input, Data>(request, Input, async (input, { dfs }) => {
    const target = stripDomain(input.target)

    // ── Parallel batch: everything that doesn't depend on derived state. ──
    //   - ranked_keywords           → KPIs, top movers, SERP features, KW table
    //   - historical_rank_overview  → 12-month visibility trend
    //   - relevant_pages            → pages report
    const [rankedEnv, historicalEnv, pagesEnv] = await Promise.all([
      dfs("/v3/dataforseo_labs/google/ranked_keywords/live", [
        {
          target,
          ...US_LOCATION,
          limit: input.limit,
          load_rank_absolute: true,
          order_by: ["ranked_serp_element.serp_item.etv,desc"],
        },
      ]),
      dfs("/v3/dataforseo_labs/google/historical_rank_overview/live", [
        {
          target,
          ...US_LOCATION,
          date_from: historicalDateFrom(),
          date_to: today(),
        },
      ]),
      dfs("/v3/dataforseo_labs/google/relevant_pages/live", [
        { target, ...US_LOCATION, limit: 50 },
      ]),
    ])

    // ── Parse ranked_keywords ─────────────────────────────────────────────
    type RawRanked = {
      keyword_data?: {
        keyword?: string
        keyword_info?: { search_volume?: number | null; cpc?: number | null }
        keyword_properties?: { keyword_difficulty?: number | null }
        search_intent_info?: { main_intent?: string | null }
      }
      ranked_serp_element?: {
        serp_item?: {
          type?: string | null
          rank_absolute?: number | null
          rank_group?: number | null
          rank_changes?: {
            previous_rank_absolute?: number | null
            is_new?: boolean
            is_up?: boolean
            is_down?: boolean
          } | null
          etv?: number | null
          estimated_paid_traffic_cost?: number | null
          url?: string | null
          relative_url?: string | null
        }
      }
    }

    const rankedRaw = dfsItems<RawRanked>(rankedEnv)

    type EnrichedRanked = {
      keyword: string
      position: number
      previous: number | null
      delta: number | null
      volume: number | null
      cpc: number | null
      etv: number
      paidValue: number
      kd: number | null
      url: string
      type: string | null
      intentInline: string | null
    }

    const enriched: EnrichedRanked[] = []
    for (const it of rankedRaw) {
      const kw = it.keyword_data?.keyword
      const serp = it.ranked_serp_element?.serp_item
      if (!kw || !serp) continue
      const position = serp.rank_absolute ?? serp.rank_group ?? 0
      if (!position) continue
      const previous = serp.rank_changes?.previous_rank_absolute ?? null
      const delta = previous != null ? previous - position : null
      enriched.push({
        keyword: kw,
        position,
        previous,
        delta,
        volume: it.keyword_data?.keyword_info?.search_volume ?? null,
        cpc: it.keyword_data?.keyword_info?.cpc ?? null,
        etv: serp.etv ?? 0,
        paidValue: serp.estimated_paid_traffic_cost ?? 0,
        kd: it.keyword_data?.keyword_properties?.keyword_difficulty ?? null,
        url:
          serp.relative_url ||
          (serp.url ? safePath(serp.url) : "") ||
          serp.url ||
          "",
        type: serp.type ?? null,
        intentInline: it.keyword_data?.search_intent_info?.main_intent ?? null,
      })
    }

    // ── KPIs from ranked_keywords ─────────────────────────────────────────
    const trackedKeywords = enriched.length
    const totalPaidValue = enriched.reduce((s, r) => s + r.paidValue, 0)
    const avgPosition =
      enriched.length > 0
        ? enriched.reduce((s, r) => s + r.position, 0) / enriched.length
        : null

    // Visibility = Σ(CTR(pos) × volume) ÷ Σ(volume) — the industry-standard
    // "share-of-clicks" calculation. Returns a 0–100 percentage.
    let weightedCtr = 0
    let totalVolume = 0
    for (const r of enriched) {
      const vol = r.volume ?? 0
      if (vol <= 0) continue
      weightedCtr += ctrFor(r.position) * vol
      totalVolume += vol
    }
    const visibilityScore =
      totalVolume > 0 ? (weightedCtr / totalVolume) * 100 : 0

    // ── SERP features owned (count by serp_item.type) ─────────────────────
    const featureCounts = new Map<string, number>()
    for (const r of enriched) {
      if (!r.type || r.type === "organic") continue
      featureCounts.set(r.type, (featureCounts.get(r.type) ?? 0) + 1)
    }
    const serpFeatures: SerpFeatureRow[] = [...featureCounts.entries()]
      .map(([type, count]) => ({ type, label: serpFeatureLabel(type), count }))
      .sort((a, b) => b.count - a.count)
    const totalSerpFeaturePlacements = serpFeatures.reduce(
      (s, r) => s + r.count,
      0,
    )

    // ── Top gainers / losers (require previous_rank_absolute) ─────────────
    const withDelta = enriched.filter((r) => r.delta != null && r.delta !== 0)
    const topGainers: Mover[] = withDelta
      .filter((r) => (r.delta ?? 0) > 0)
      .sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0))
      .slice(0, 5)
      .map((r) => ({
        keyword: r.keyword,
        from: r.previous,
        to: r.position,
        delta: r.delta ?? 0,
      }))
    const topLosers: Mover[] = withDelta
      .filter((r) => (r.delta ?? 0) < 0)
      .sort((a, b) => (a.delta ?? 0) - (b.delta ?? 0))
      .slice(0, 5)
      .map((r) => ({
        keyword: r.keyword,
        from: r.previous,
        to: r.position,
        delta: r.delta ?? 0,
      }))

    // ── Keyword table rows (top N by traffic) ─────────────────────────────
    const keywordTableRows: KeywordRow[] = enriched
      .slice()
      .sort((a, b) => b.etv - a.etv)
      .slice(0, input.kw_table_limit)
      .map((r) => ({
        keyword: r.keyword,
        position: r.position,
        delta: r.delta,
        volume: r.volume,
        kd: r.kd,
        intent: r.intentInline,
        url: r.url,
      }))

    // ── Intent breakdown (separate search_intent call for accuracy) ───────
    // ranked_keywords sometimes returns `search_intent_info.main_intent`
    // inline, but coverage is spotty. A dedicated search_intent call fills
    // in the gaps. Capped at the top-200 highest-traffic keywords to keep
    // cost predictable.
    const intentKeywords = enriched
      .slice()
      .sort((a, b) => b.etv - a.etv)
      .slice(0, Math.min(enriched.length, 200))
      .map((r) => r.keyword)

    let intentEnv: unknown = null
    if (intentKeywords.length > 0) {
      intentEnv = await dfs(
        "/v3/dataforseo_labs/google/search_intent/live",
        [{ keywords: intentKeywords, ...US_LOCATION }],
        { timeoutMs: 90_000 },
      ).catch(() => null)
    }

    const intentByKw = new Map<string, string>()
    if (intentEnv) {
      for (const raw of dfsItems<{
        keyword?: string
        keyword_intent?: { label?: string | null }
      }>(intentEnv)) {
        const label = raw.keyword_intent?.label
        if (raw.keyword && label) {
          intentByKw.set(raw.keyword.toLowerCase(), label.toLowerCase())
        }
      }
    }
    // Backfill the keyword-table rows from the dedicated intent call.
    for (const row of keywordTableRows) {
      const fresh = intentByKw.get(row.keyword.toLowerCase())
      if (fresh) row.intent = fresh
    }

    const intentCounts = new Map<string, number>()
    for (const r of enriched) {
      const label =
        intentByKw.get(r.keyword.toLowerCase()) ??
        r.intentInline?.toLowerCase() ??
        null
      if (!label) continue
      intentCounts.set(label, (intentCounts.get(label) ?? 0) + 1)
    }
    const intentTotal = [...intentCounts.values()].reduce((s, v) => s + v, 0)
    const intent: IntentRow[] = INTENT_ORDER.filter((i) =>
      intentCounts.has(i),
    ).map((i) => {
      const count = intentCounts.get(i) ?? 0
      return {
        intent: i,
        count,
        pct: intentTotal > 0 ? (count / intentTotal) * 100 : 0,
      }
    })

    // ── Visibility trend (12 months) from historical_rank_overview ────────
    // historical_rank_overview returns one item per month with
    // metrics.organic.etv. We don't have monthly per-keyword volumes, so we
    // approximate visibility-by-month as the relative ETV shape scaled to
    // the current visibility score: visibility_m = (etv_m / etv_max) ×
    // current_visibility%. This preserves the trend's *shape* (which is the
    // signal users care about) while landing on the right end-of-period
    // value.
    const histItems = dfsItems<{
      year?: number
      month?: number
      metrics?: { organic?: { etv?: number; count?: number } }
    }>(historicalEnv)
    const histSorted = histItems
      .filter((i) => i.year != null && i.month != null)
      .sort((a, b) => {
        const ay = a.year ?? 0
        const by = b.year ?? 0
        if (ay !== by) return ay - by
        return (a.month ?? 0) - (b.month ?? 0)
      })
      .slice(-12)
    const histEtvs = histSorted.map((i) => i.metrics?.organic?.etv ?? 0)
    const maxHistEtv = Math.max(1, ...histEtvs)
    const visibilityTrend: TrendPoint[] = histSorted.map((i) => {
      const monthName =
        MONTH_LABELS[(i.month ?? 1) - 1] ?? String(i.month ?? "")
      const etv = i.metrics?.organic?.etv ?? 0
      const visibility = visibilityScore * (etv / maxHistEtv)
      return { label: monthName, visibility }
    })

    // ── Pages report ──────────────────────────────────────────────────────
    type RawPage = {
      page_address?: string
      url?: string
      metrics?: { organic?: { count?: number; etv?: number } }
    }
    const pagesRaw = dfsItems<RawPage>(pagesEnv)
    const pagesSorted = [...pagesRaw].sort(
      (a, b) =>
        (b.metrics?.organic?.etv ?? 0) - (a.metrics?.organic?.etv ?? 0),
    )

    // Build a per-page top-keyword lookup from ranked_keywords (by ETV).
    const topKwByUrl = new Map<string, string>()
    for (const r of enriched.slice().sort((a, b) => b.etv - a.etv)) {
      if (!r.url) continue
      if (!topKwByUrl.has(r.url)) topKwByUrl.set(r.url, r.keyword)
    }
    const pages: PageRow[] = pagesSorted.slice(0, 10).map((p) => {
      const rawUrl = p.page_address ?? p.url ?? ""
      const path = rawUrl ? safePath(rawUrl) || rawUrl : ""
      return {
        url: path,
        keywords: p.metrics?.organic?.count ?? 0,
        etv: Math.round(p.metrics?.organic?.etv ?? 0),
        topKeyword: topKwByUrl.get(path) ?? null,
      }
    })

    // ── City SERP matrix (top-N keywords × each selected city) ────────────
    // Cycle-over-cycle deltas would require persisting previous snapshots;
    // for now every cell's delta is null and the UI renders "—".
    const citySerpKeywords = keywordTableRows
      .slice(0, input.city_kw_limit)
      .map((r) => r.keyword)
    const cityLocations = input.cities
    const cityKey = (c: { location_name: string }) => c.location_name

    const serpEnvelopes: unknown[] = []
    const citySerp: CitySerpRow[] = []
    if (citySerpKeywords.length > 0 && cityLocations.length > 0) {
      const pairs = citySerpKeywords.flatMap((kw) =>
        cityLocations.map((city) => ({ keyword: kw, city })),
      )
      const results = await Promise.all(
        pairs.map(({ keyword, city }) =>
          dfs(
            "/v3/serp/google/organic/live/advanced",
            [
              {
                keyword,
                location_code: city.location_code,
                language_code: input.language_code,
                depth: 100,
              },
            ],
            { timeoutMs: 90_000 },
          )
            .then((env) => ({ keyword, city, env, error: null as null }))
            .catch((err) => ({
              keyword,
              city,
              env: null,
              error: err instanceof Error ? err.message : "serp failed",
            })),
        ),
      )
      for (const r of results) if (r.env) serpEnvelopes.push(r.env)

      const positionsByKw = new Map<
        string,
        Record<string, { pos: number | null; delta: number | null }>
      >()
      for (const kw of citySerpKeywords) {
        positionsByKw.set(
          kw,
          Object.fromEntries(
            cityLocations.map((c) => [cityKey(c), { pos: null, delta: null }]),
          ),
        )
      }
      for (const r of results) {
        const pos = findTargetPositionInSerp(r.env, target)
        const row = positionsByKw.get(r.keyword)
        if (row) row[cityKey(r.city)] = { pos, delta: null }
      }
      for (const kw of citySerpKeywords) {
        citySerp.push({
          keyword: kw,
          positions: positionsByKw.get(kw) ?? {},
        })
      }
    }
    const cities = cityLocations.map(cityKey)

    const kpis: Kpis = {
      visibilityScore,
      trackedKeywords,
      cityCount: cities.length,
      avgPosition,
      // ETV here is monthly organic clicks; multiplying by CPC gives the
      // equivalent monthly value the same traffic would cost as paid search.
      // DFS's `estimated_paid_traffic_cost` already returns this product, so
      // prefer its sum when available; fall back to etv × avg-cpc only when
      // every row's paidValue is zero.
      trafficValueUsd:
        totalPaidValue > 0
          ? Math.round(totalPaidValue)
          : Math.round(
              enriched.reduce((s, r) => s + r.etv * (r.cpc ?? 0), 0),
            ),
      serpFeatures: totalSerpFeaturePlacements,
    }

    return {
      data: {
        target,
        market: US_LOCATION.location_name,
        cities,
        kpis,
        visibilityTrend,
        topGainers,
        topLosers,
        serpFeatures,
        intent,
        pages,
        keywords: keywordTableRows,
        citySerp,
      },
      endpoints: [
        "/v3/dataforseo_labs/google/ranked_keywords/live",
        "/v3/dataforseo_labs/google/historical_rank_overview/live",
        "/v3/dataforseo_labs/google/relevant_pages/live",
        ...(intentEnv ? ["/v3/dataforseo_labs/google/search_intent/live"] : []),
        ...(serpEnvelopes.length > 0
          ? ["/v3/serp/google/organic/live/advanced"]
          : []),
      ],
      costUsd: dfsCost(
        rankedEnv,
        historicalEnv,
        pagesEnv,
        intentEnv,
        ...serpEnvelopes,
      ),
    }
  })
}

function safePath(u: string): string {
  try {
    return new URL(u).pathname
  } catch {
    return ""
  }
}

function findTargetPositionInSerp(env: unknown, target: string): number | null {
  if (!env) return null
  const e = env as {
    tasks?: {
      result?: ({
        items?: { type?: string; rank_absolute?: number; domain?: string }[]
      } | null)[] | null
    }[] | null
  }
  const items = e?.tasks?.[0]?.result?.[0]?.items ?? []
  const targetRoot = rootDomain(target)
  let best: number | null = null
  for (const it of items) {
    if (it.type !== "organic") continue
    if (!it.domain) continue
    if (rootDomain(it.domain) === targetRoot) {
      const r = it.rank_absolute ?? null
      if (r != null && (best == null || r < best)) best = r
    }
  }
  return best
}
