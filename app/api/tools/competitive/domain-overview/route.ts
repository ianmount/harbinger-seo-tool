import { z } from "zod"
import { dfsCost, locationFields, runTool } from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const CityInput = z.object({
  location_code: z.number().int(),
  location_name: z.string().min(1),
})

const Input = z.object({
  target: z.string().min(3),
  location_code: z.number().int().optional(),
  location_name: z.string().optional(),
  language_code: z.string().default("en"),
  // Cities are picked from the DFS Labs taxonomy on the client (via
  // LocationAutocomplete), so we get a validated location_code per city and
  // can feed the SERP endpoint by code rather than name — no fuzzy matching,
  // no ambiguity between "Springfield, MO" and "Springfield, IL".
  cities: z.array(CityInput).default([]),
  kw_limit: z.number().int().min(1).max(20).default(5),
})

type Kpis = {
  organicKeywords: number
  organicTraffic: number
  backlinks: number
  referringDomains: number
  rank: number
  serpFeatures: number
}

type PositionDistribution = {
  top3: number
  p4_10: number
  p11_20: number
  p21_50: number
  p51_100: number
  total: number
}

type PositionChanges = {
  isNew: number
  isLost: number
  isUp: number
  isDown: number
}

type TrafficPoint = { label: string; etv: number }

type TopKeyword = {
  keyword: string
  position: number
  volume: number
  traffic: number
  url: string
}

type Competitor = {
  domain: string
  intersections: number
}

type BacklinkProfile = {
  total: number
  dofollowPct: number | null
  new30d: number
  lost30d: number
}

type CitySerpRow = {
  keyword: string
  positions: Record<string, number | null>
}

// Verbatim DataForSEO envelopes for every API call made during this run.
// Surfaced under `data._raw` so the dashboard can offer a "Download raw JSON"
// button — useful for debugging response-shape changes and inspecting fields
// the dashboard doesn't currently render.
type RawEnvelopes = {
  generatedAt: string
  target: string
  market: string
  envelopes: {
    "domain_rank_overview": unknown
    "historical_rank_overview": unknown
    "backlinks_summary": unknown
    "backlinks_timeseries_new_lost_summary": unknown | null
    "competitors_domain": unknown
    "ranked_keywords": unknown
    "serp_google_organic": {
      keyword: string
      city: string
      envelope: unknown | null
      error: string | null
    }[]
  }
}

type Data = {
  target: string
  market: string
  cities: string[]
  kpis: Kpis
  positionDistribution: PositionDistribution
  positionChanges: PositionChanges
  trafficTrend: TrafficPoint[]
  topKeywords: TopKeyword[]
  competitors: Competitor[]
  backlinkProfile: BacklinkProfile
  citySerp: CitySerpRow[]
  _raw: RawEnvelopes
}

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const

function stripDomain(domain: string): string {
  return domain
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase()
}

// Surfaces "metrics.organic" from /v3/dataforseo_labs/google/domain_rank_overview/live.
// DFS exposes per-position-bucket counters (`pos_1`, `pos_2_3`, ..., `pos_91_100`)
// and per-row-state counters (`is_new`, `is_up`, `is_down`, `is_lost`) on this
// object — both of which power the spec's position distribution bar and
// position-change cards.
function readOrganicMetrics(
  env: unknown,
): Record<string, number> {
  const items = readLabsItems(env)
  const first = (items[0] ?? {}) as {
    metrics?: { organic?: Record<string, unknown> }
  }
  const organic = first.metrics?.organic ?? {}
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(organic)) {
    if (typeof v === "number") out[k] = v
  }
  return out
}

// Many DFS "Labs" endpoints wrap items at tasks[0].result[0].items, but
// domain_rank_overview returns the snapshot at tasks[0].result[0] directly.
// readLabsItems is permissive: it returns the items array if it exists,
// otherwise wraps result[0] in a single-element array.
function readLabsItems(env: unknown): unknown[] {
  const e = env as
    | { tasks?: { result?: ({ items?: unknown[] } | unknown)[] | null }[] }
    | null
  const result = e?.tasks?.[0]?.result
  if (!result || result.length === 0) return []
  const first = result[0] as { items?: unknown[] } | null
  if (first && Array.isArray(first.items)) return first.items
  return [first]
}

function sumBucket(metrics: Record<string, number>, keys: string[]): number {
  let total = 0
  for (const k of keys) total += metrics[k] ?? 0
  return total
}

function buildPositionDistribution(
  metrics: Record<string, number>,
): PositionDistribution {
  // domain_rank_overview groups positions as: pos_1, pos_2_3, pos_4_10,
  // pos_11_20, then 10-wide buckets through pos_91_100. The spec collapses
  // to Top 3 / 4–10 / 11–20 / 21–50 / 51–100.
  const top3 = sumBucket(metrics, ["pos_1", "pos_2_3"])
  const p4_10 = sumBucket(metrics, ["pos_4_10"])
  const p11_20 = sumBucket(metrics, ["pos_11_20"])
  const p21_50 = sumBucket(metrics, [
    "pos_21_30",
    "pos_31_40",
    "pos_41_50",
  ])
  const p51_100 = sumBucket(metrics, [
    "pos_51_60",
    "pos_61_70",
    "pos_71_80",
    "pos_81_90",
    "pos_91_100",
  ])
  const total = top3 + p4_10 + p11_20 + p21_50 + p51_100
  return { top3, p4_10, p11_20, p21_50, p51_100, total }
}

// SERP-feature-presence keys living alongside `pos_*`/`is_*` on metrics.organic.
// Each is a count of keywords for which the domain shows that feature. We
// count features where presence > 0 to match the spec's "types ranking" KPI.
const SERP_FEATURE_KEYS = [
  "featured_snippet",
  "local_pack",
  "knowledge_graph",
  "people_also_ask",
  "image",
  "image_pack",
  "video",
  "carousel",
  "shopping",
  "twitter",
  "top_stories",
  "answer_box",
  "ai_overview",
  "related_searches",
  "site_links",
  "faq",
  "questions_and_answers",
  "reviews",
  "podcasts",
  "events",
] as const

function countSerpFeatures(metrics: Record<string, number>): number {
  let n = 0
  for (const k of SERP_FEATURE_KEYS) if ((metrics[k] ?? 0) > 0) n++
  return n
}

export async function POST(request: Request) {
  return runTool<typeof Input, Data>(request, Input, async (input, { dfs }) => {
    const target = stripDomain(input.target)
    const loc = locationFields(input)
    const marketLabel =
      typeof loc.location_name === "string"
        ? loc.location_name
        : `location_code=${String(loc.location_code ?? "")}`

    // Parallel batch A: everything that doesn't depend on derived state.
    //   - domain_rank_overview   → KPIs (organic kw/traffic), pos buckets,
    //                              is_new/is_lost/is_up/is_down, SERP features
    //   - historical_rank_overview → monthly etv buckets for the 12mo trend
    //   - backlinks/summary       → backlinks total + dofollow ratio + ref domains
    //   - timeseries_new_lost     → new/lost backlinks in last 30d
    //   - competitors_domain      → top 5 competitors by intersections
    //   - ranked_keywords         → top N keywords with ranking URL
    const [
      overviewEnv,
      historicalEnv,
      summaryEnv,
      timeseriesEnv,
      competitorsEnv,
      rankedEnv,
    ] = await Promise.all([
      dfs(
        "/v3/dataforseo_labs/google/domain_rank_overview/live",
        [{ target, ...loc }],
      ),
      dfs(
        "/v3/dataforseo_labs/google/historical_rank_overview/live",
        [{ target, ...loc }],
      ),
      dfs("/v3/backlinks/summary/live", [
        { target, internal_list_limit: 1, backlinks_status_type: "live" },
      ]),
      dfs("/v3/backlinks/timeseries_new_lost_summary/live", [
        { target, date_from: backlinksTimeseriesDateFrom(), group_range: "day" },
      ]).catch(() => null),
      dfs(
        "/v3/dataforseo_labs/google/competitors_domain/live",
        [{ target, ...loc, limit: 5 }],
      ),
      dfs(
        "/v3/dataforseo_labs/google/ranked_keywords/live",
        [
          {
            target,
            ...loc,
            limit: input.kw_limit,
            order_by: ["ranked_serp_element.serp_item.etv,desc"],
          },
        ],
      ),
    ])

    // ── KPIs + position distribution + position changes ──────────────────
    const organic = readOrganicMetrics(overviewEnv)
    const positionDistribution = buildPositionDistribution(organic)
    const positionChanges: PositionChanges = {
      isNew: organic["is_new"] ?? 0,
      isLost: organic["is_lost"] ?? 0,
      isUp: organic["is_up"] ?? 0,
      isDown: organic["is_down"] ?? 0,
    }

    // dataforseo_labs overview also reports a numeric "rank" (0–1000)
    // and the metrics.organic.{count,etv} totals.
    const overviewItems = readLabsItems(overviewEnv) as {
      metrics?: { organic?: { count?: number; etv?: number } }
      rank?: number
    }[]
    const overviewItem = overviewItems[0] ?? {}
    const organicKeywords = overviewItem.metrics?.organic?.count ?? 0
    const organicTraffic = Math.round(overviewItem.metrics?.organic?.etv ?? 0)
    const rank = overviewItem.rank ?? 0

    // ── Backlinks summary ────────────────────────────────────────────────
    const summaryTaskResult = (
      summaryEnv as {
        tasks?: { result?: ({
          backlinks?: number
          referring_main_domains?: number
          referring_domains?: number
          backlinks_dofollow?: number
        } | null)[] | null }[]
      }
    ).tasks?.[0]?.result?.[0] ?? {}
    const totalBacklinks = summaryTaskResult.backlinks ?? 0
    const referringDomains =
      summaryTaskResult.referring_main_domains ??
      summaryTaskResult.referring_domains ??
      0
    const dofollowPct =
      totalBacklinks > 0 && summaryTaskResult.backlinks_dofollow != null
        ? (summaryTaskResult.backlinks_dofollow / totalBacklinks) * 100
        : null

    // ── Backlinks 30-day new/lost ────────────────────────────────────────
    const { new30d, lost30d } = sumBacklinksTimeseries(timeseriesEnv)

    // ── Historical traffic trend (12 months) ─────────────────────────────
    const trafficTrend = buildTrafficTrend(historicalEnv)

    // ── Top organic keywords ─────────────────────────────────────────────
    const topKeywords = parseTopKeywords(rankedEnv, input.kw_limit)

    // ── Top competitors ──────────────────────────────────────────────────
    const competitors = parseCompetitors(competitorsEnv)

    // ── KPIs assembly ────────────────────────────────────────────────────
    const kpis: Kpis = {
      organicKeywords,
      organicTraffic,
      backlinks: totalBacklinks,
      referringDomains,
      rank,
      serpFeatures: countSerpFeatures(organic),
    }

    const backlinkProfile: BacklinkProfile = {
      total: totalBacklinks,
      dofollowPct,
      new30d,
      lost30d,
    }

    // ── City SERP matrix: one SERP call per (keyword × city) ─────────────
    // Cities come from the client as { location_code, location_name } pairs
    // sourced from DFS's Labs locations taxonomy. We send location_code to
    // /v3/serp/google/organic/live/advanced — codes are unambiguous, no fuzzy
    // matching, and DFS will reject typos at the city-picker stage rather
    // than mid-batch here.
    const cityLocations = input.cities
    const cityKey = (c: { location_name: string }) => c.location_name
    const serpEnvelopes: unknown[] = []
    const serpRawRows: RawEnvelopes["envelopes"]["serp_google_organic"] = []
    const citySerp: CitySerpRow[] = []
    if (topKeywords.length > 0 && cityLocations.length > 0) {
      const pairs = topKeywords.flatMap((kw) =>
        cityLocations.map((city) => ({ keyword: kw.keyword, city })),
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
      // Accumulate envelopes for cost reporting and raw-export rows.
      for (const r of results) {
        if (r.env) serpEnvelopes.push(r.env)
        serpRawRows.push({
          keyword: r.keyword,
          city: cityKey(r.city),
          envelope: r.env,
          error: r.error,
        })
      }
      const positionsByKw = new Map<string, Record<string, number | null>>()
      for (const kw of topKeywords) {
        positionsByKw.set(
          kw.keyword,
          Object.fromEntries(cityLocations.map((c) => [cityKey(c), null])),
        )
      }
      for (const r of results) {
        const pos = findTargetPositionInSerp(r.env, target)
        const row = positionsByKw.get(r.keyword)
        if (row) row[cityKey(r.city)] = pos
      }
      for (const kw of topKeywords) {
        citySerp.push({
          keyword: kw.keyword,
          positions: positionsByKw.get(kw.keyword) ?? {},
        })
      }
    }
    const cities = cityLocations.map(cityKey)

    const rawEnvelopes: RawEnvelopes = {
      generatedAt: new Date().toISOString(),
      target,
      market: marketLabel,
      envelopes: {
        domain_rank_overview: overviewEnv,
        historical_rank_overview: historicalEnv,
        backlinks_summary: summaryEnv,
        backlinks_timeseries_new_lost_summary: timeseriesEnv,
        competitors_domain: competitorsEnv,
        ranked_keywords: rankedEnv,
        serp_google_organic: serpRawRows,
      },
    }

    return {
      data: {
        target,
        market: marketLabel,
        cities,
        kpis,
        positionDistribution,
        positionChanges,
        trafficTrend,
        topKeywords,
        competitors,
        backlinkProfile,
        citySerp,
        _raw: rawEnvelopes,
      },
      endpoints: [
        "/v3/dataforseo_labs/google/domain_rank_overview/live",
        "/v3/dataforseo_labs/google/historical_rank_overview/live",
        "/v3/backlinks/summary/live",
        "/v3/backlinks/timeseries_new_lost_summary/live",
        "/v3/dataforseo_labs/google/competitors_domain/live",
        "/v3/dataforseo_labs/google/ranked_keywords/live",
        ...(serpEnvelopes.length > 0
          ? ["/v3/serp/google/organic/live/advanced"]
          : []),
      ],
      costUsd: dfsCost(
        overviewEnv,
        historicalEnv,
        summaryEnv,
        timeseriesEnv,
        competitorsEnv,
        rankedEnv,
        ...serpEnvelopes,
      ),
    }
  })
}

// ─── helpers ────────────────────────────────────────────────────────────────

function backlinksTimeseriesDateFrom(): string {
  // 35 days back so DFS has enough daily buckets to sum to 30; the 5-day
  // overlap absorbs timezone / processing lag without pulling unrelated data.
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - 35)
  return d.toISOString().slice(0, 10)
}

function sumBacklinksTimeseries(env: unknown): {
  new30d: number
  lost30d: number
} {
  const e = env as {
    tasks?: {
      result?: ({
        items?: { new_backlinks?: number; lost_backlinks?: number }[]
      } | null)[] | null
    }[] | null
  } | null
  if (!e) return { new30d: 0, lost30d: 0 }
  const items = e.tasks?.[0]?.result?.[0]?.items ?? []
  const cutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000
  // Items are date-keyed in DFS (each has a `date` field), but the cheap
  // path is to take the last 30 elements (group_range=day → 1/day).
  void cutoffMs
  const last30 = items.slice(-30)
  let n = 0
  let l = 0
  for (const it of last30) {
    n += it.new_backlinks ?? 0
    l += it.lost_backlinks ?? 0
  }
  return { new30d: n, lost30d: l }
}

function buildTrafficTrend(env: unknown): TrafficPoint[] {
  // historical_rank_overview returns one item per month with
  // `year`, `month`, and the standard metrics.organic block (etv, count, …).
  const e = env as {
    tasks?: {
      result?: ({
        items?: {
          year?: number
          month?: number
          metrics?: { organic?: { etv?: number } }
        }[]
      } | null)[] | null
    }[] | null
  } | null
  const items = e?.tasks?.[0]?.result?.[0]?.items ?? []
  // Sort ascending by year then month, take the last 12.
  const sorted = [...items]
    .filter((i) => i.year != null && i.month != null)
    .sort((a, b) => {
      const ay = a.year ?? 0
      const by = b.year ?? 0
      if (ay !== by) return ay - by
      return (a.month ?? 0) - (b.month ?? 0)
    })
  const recent = sorted.slice(-12)
  return recent.map((i) => ({
    label: MONTH_LABELS[(i.month ?? 1) - 1] ?? String(i.month ?? ""),
    etv: Math.round(i.metrics?.organic?.etv ?? 0),
  }))
}

function parseTopKeywords(env: unknown, limit: number): TopKeyword[] {
  // ranked_keywords nests under tasks[0].result[0].items, with each row
  // shaped { keyword_data: { keyword, keyword_info: { search_volume } },
  // ranked_serp_element: { serp_item: { rank_absolute, etv, url } } }.
  const e = env as {
    tasks?: {
      result?: ({
        items?: {
          keyword_data?: {
            keyword?: string
            keyword_info?: { search_volume?: number | null }
          }
          ranked_serp_element?: {
            serp_item?: {
              rank_absolute?: number | null
              rank_group?: number | null
              etv?: number | null
              url?: string | null
              relative_url?: string | null
            }
          }
        }[]
      } | null)[] | null
    }[] | null
  } | null
  const items = e?.tasks?.[0]?.result?.[0]?.items ?? []
  const out: TopKeyword[] = []
  for (const it of items) {
    const kw = it.keyword_data?.keyword
    const serp = it.ranked_serp_element?.serp_item
    if (!kw || !serp) continue
    const position = serp.rank_absolute ?? serp.rank_group ?? 0
    if (!position) continue
    const url =
      serp.relative_url ||
      (serp.url ? new URL(serp.url).pathname : "")
    out.push({
      keyword: kw,
      position,
      volume: it.keyword_data?.keyword_info?.search_volume ?? 0,
      traffic: Math.round(serp.etv ?? 0),
      url,
    })
    if (out.length >= limit) break
  }
  return out
}

function parseCompetitors(env: unknown): Competitor[] {
  const e = env as {
    tasks?: {
      result?: ({
        items?: { domain?: string; intersections?: number | null }[]
      } | null)[] | null
    }[] | null
  } | null
  const items = e?.tasks?.[0]?.result?.[0]?.items ?? []
  const out: Competitor[] = []
  for (const it of items) {
    if (!it.domain) continue
    out.push({
      domain: it.domain,
      intersections: it.intersections ?? 0,
    })
  }
  return out
}

// Find the position the *target* domain occupies in a SERP envelope. Returns
// null when the target isn't in the top 100. Strips protocol/subdomain
// prefixes so "www.example.com" matches "example.com".
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
  for (const it of items) {
    if (it.type !== "organic") continue
    if (!it.domain) continue
    const d = it.domain.toLowerCase().replace(/^www\./, "")
    if (d === target || d.endsWith(`.${target}`)) {
      return it.rank_absolute ?? null
    }
  }
  return null
}
