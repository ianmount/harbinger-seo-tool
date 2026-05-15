import { z } from "zod"
import {
  dfsCost,
  dfsItems,
  dfsResultItems,
  locationFields,
  runTool,
} from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 180

const MarketInput = z.object({
  location_code: z.number().int(),
  location_name: z.string().min(1),
})

const Input = z.object({
  keyword: z.string().min(1),
  /** National scope. Defaults to United States (location_code 2840). */
  location_code: z.number().int().optional(),
  location_name: z.string().optional(),
  language_code: z.string().default("en"),
  /** Optional city scopes for the per-city volume bars + scope chips. */
  city_markets: z.array(MarketInput).max(8).default([]),
  /** Optional domain to highlight in SERP composition. */
  user_domain: z.string().optional(),
})

export type MarketKey = "national" | `city:${number}`

export type ScopeMarket = {
  key: MarketKey
  label: string
  location_code: number
  location_name: string
  is_national: boolean
}

export type Kpis = {
  volume: number | null
  cpc: number | null
  /** 0..1 — DFS `competition_index / 100` (Ads) or fallback Labs competition_level mapped. */
  ad_density: number | null
  keyword_difficulty: number | null
  intent: string | null
}

export type TrendPoint = {
  /** YYYY-MM. */
  date: string
  volume: number | null
}

export type CityVolume = {
  key: MarketKey
  label: string
  volume: number | null
}

export type SerpRow = {
  position: number
  domain: string
  url: string
  title: string | null
  rank: number | null
  is_user_domain: boolean
}

export type RelatedRow = {
  keyword: string
  volume: number | null
}

export type Data = {
  keyword: string
  user_domain: string | null
  markets: ScopeMarket[]
  kpis: Record<MarketKey, Kpis>
  trend: TrendPoint[]
  city_volumes: CityVolume[]
  serp: SerpRow[]
  serp_features: string[]
  paa: string[]
  related: RelatedRow[]
  phrase_match: RelatedRow[]
}

const INTENT_LABEL: Record<string, string> = {
  informational: "Informational",
  navigational: "Navigational",
  commercial: "Commercial",
  transactional: "Transactional",
}

function stripDomain(d: string): string {
  return d.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/.*$/, "").toLowerCase()
}

function domainMatches(serpDomain: string, userDomain: string): boolean {
  const a = serpDomain.toLowerCase().replace(/^www\./, "")
  const b = userDomain.toLowerCase().replace(/^www\./, "")
  return a === b || a.endsWith(`.${b}`)
}

export async function POST(request: Request) {
  return runTool<typeof Input, Data>(request, Input, async (input, { dfs }) => {
    const nationalLoc = locationFields(input)
    const nationalCode = input.location_code ?? 2840
    const nationalLabel = input.location_name ?? "United States"
    const userDomain = input.user_domain ? stripDomain(input.user_domain) : null

    const markets: ScopeMarket[] = [
      {
        key: "national",
        label: "National",
        location_code: nationalCode,
        location_name: nationalLabel,
        is_national: true,
      },
      ...input.city_markets.map((c) => ({
        key: `city:${c.location_code}` as MarketKey,
        label: c.location_name.split(",")[0] ?? c.location_name,
        location_code: c.location_code,
        location_name: c.location_name,
        is_national: false,
      })),
    ]

    // ── Parallel batch of independent calls ──────────────────────────────
    const overviewBody = [
      { keywords: [input.keyword], ...nationalLoc, include_serp_info: false },
    ]
    const historicalBody = [{ keywords: [input.keyword], ...nationalLoc }]
    const intentBody = [
      {
        keywords: [input.keyword],
        ...(input.location_code
          ? { language_code: input.language_code }
          : { language_name: "English" }),
      },
    ]
    const adsCalls = markets.map((m) =>
      dfs("/v3/keywords_data/google_ads/search_volume/live", [
        {
          keywords: [input.keyword],
          ...(m.is_national
            ? nationalLoc
            : {
                location_code: m.location_code,
                language_code: input.language_code,
              }),
        },
      ]),
    )
    const serpBody = [
      {
        keyword: input.keyword,
        ...nationalLoc,
        depth: 10,
        people_also_ask_click_depth: 2,
      },
    ]
    const relatedBody = [
      {
        keyword: input.keyword,
        ...nationalLoc,
        limit: 10,
      },
    ]
    const phraseBody = [
      {
        keyword: input.keyword,
        ...nationalLoc,
        limit: 10,
      },
    ]

    const [
      overviewEnv,
      historicalEnv,
      intentEnv,
      serpEnv,
      relatedEnv,
      phraseEnv,
      ...adsEnvs
    ] = await Promise.all([
      dfs("/v3/dataforseo_labs/google/keyword_overview/live", overviewBody),
      dfs(
        "/v3/dataforseo_labs/google/historical_keyword_data/live",
        historicalBody,
      ),
      dfs("/v3/dataforseo_labs/google/search_intent/live", intentBody).catch(
        () => null,
      ),
      dfs("/v3/serp/google/organic/live/advanced", serpBody, {
        timeoutMs: 90_000,
      }),
      dfs("/v3/dataforseo_labs/google/related_keywords/live", relatedBody),
      dfs(
        "/v3/dataforseo_labs/google/keyword_suggestions/live",
        phraseBody,
      ),
      ...adsCalls,
    ])

    // ── National KPI base from keyword_overview ──────────────────────────
    let kd: number | null = null
    let nationalLabsVolume: number | null = null
    let nationalLabsCpc: number | null = null
    let nationalIntentRaw: string | null = null
    for (const raw of dfsItems<{
      keyword?: string
      keyword_info?: {
        search_volume?: number | null
        cpc?: number | null
      } | null
      keyword_properties?: { keyword_difficulty?: number | null } | null
      search_intent_info?: { main_intent?: string | null } | null
    }>(overviewEnv)) {
      if (raw.keyword?.toLowerCase() !== input.keyword.toLowerCase()) continue
      nationalLabsVolume = raw.keyword_info?.search_volume ?? null
      nationalLabsCpc = raw.keyword_info?.cpc ?? null
      kd = raw.keyword_properties?.keyword_difficulty ?? null
      nationalIntentRaw = raw.search_intent_info?.main_intent ?? null
      break
    }

    // Search intent live takes precedence over the inline label.
    if (intentEnv) {
      for (const raw of dfsItems<{
        keyword?: string
        keyword_intent?: { label?: string }
      }>(intentEnv)) {
        if (raw.keyword?.toLowerCase() === input.keyword.toLowerCase()) {
          nationalIntentRaw = raw.keyword_intent?.label ?? nationalIntentRaw
          break
        }
      }
    }
    const intentLabel = nationalIntentRaw
      ? INTENT_LABEL[nationalIntentRaw] ?? nationalIntentRaw
      : null

    // ── Per-market KPIs from google_ads/search_volume ────────────────────
    const kpis: Record<MarketKey, Kpis> = {} as Record<MarketKey, Kpis>
    const cityVolumes: CityVolume[] = []
    markets.forEach((m, i) => {
      const env = adsEnvs[i]
      let volume: number | null = null
      let cpc: number | null = null
      let competitionIndex: number | null = null
      for (const raw of dfsResultItems<{
        keyword?: string
        search_volume?: number | null
        cpc?: number | null
        competition_index?: number | null
      }>(env)) {
        if (raw.keyword?.toLowerCase() !== input.keyword.toLowerCase()) continue
        volume = raw.search_volume ?? null
        cpc = raw.cpc ?? null
        // DFS competition_index is reported on a 0..100 scale; normalise to 0..1
        // so the UI can render it as the "Ad density" decimal the spec shows.
        competitionIndex =
          typeof raw.competition_index === "number"
            ? raw.competition_index / 100
            : null
        break
      }
      kpis[m.key] = {
        volume: volume ?? (m.is_national ? nationalLabsVolume : null),
        cpc: cpc ?? (m.is_national ? nationalLabsCpc : null),
        ad_density: competitionIndex,
        keyword_difficulty: kd,
        intent: intentLabel,
      }
      if (!m.is_national) {
        cityVolumes.push({
          key: m.key,
          label: m.label,
          volume: kpis[m.key].volume,
        })
      }
    })

    // ── 12-month volume trend (national) ─────────────────────────────────
    // DFS Labs historical_keyword_data nests volume two levels deep:
    //   items[].history[].keyword_info.search_volume          (per snapshot)
    //   items[].history[].keyword_info.monthly_searches[]     (rolling 12)
    // The cleanest 12-month series is the most recent snapshot's
    // monthly_searches array. Fall back to iterating snapshots if that's
    // unavailable (older account tiers don't always return monthly_searches).
    const monthly: TrendPoint[] = []
    type HistoryEntry = {
      year?: number
      month?: number
      keyword_info?: {
        search_volume?: number | null
        monthly_searches?: {
          year?: number
          month?: number
          search_volume?: number | null
        }[] | null
      } | null
    }
    const histItem = dfsItems<{
      keyword?: string
      history?: HistoryEntry[]
    }>(historicalEnv).find(
      (it) => it.keyword?.toLowerCase() === input.keyword.toLowerCase(),
    )
    if (histItem?.history?.length) {
      const ordered = [...histItem.history].sort((a, b) => {
        const av = (a.year ?? 0) * 12 + (a.month ?? 0)
        const bv = (b.year ?? 0) * 12 + (b.month ?? 0)
        return av - bv
      })
      const newest = ordered[ordered.length - 1]
      const rolling = newest?.keyword_info?.monthly_searches ?? []
      if (rolling.length > 0) {
        for (const m of rolling) {
          if (m.year == null || m.month == null) continue
          monthly.push({
            date: `${m.year}-${String(m.month).padStart(2, "0")}`,
            volume: m.search_volume ?? null,
          })
        }
      } else {
        for (const h of ordered) {
          if (h.year == null || h.month == null) continue
          monthly.push({
            date: `${h.year}-${String(h.month).padStart(2, "0")}`,
            volume: h.keyword_info?.search_volume ?? null,
          })
        }
      }
    }
    monthly.sort((a, b) => a.date.localeCompare(b.date))
    const trend = monthly.slice(-12)

    // ── SERP composition + features + PAA ────────────────────────────────
    const serpRows: SerpRow[] = []
    const serpFeatures = new Set<string>()
    const paa: string[] = []

    const serpItems = ((serpEnv as {
      tasks?: { result?: ({ items?: unknown[] } | null)[] | null }[]
    })?.tasks?.[0]?.result?.[0]?.items ?? []) as Array<{
      type?: string
      rank_absolute?: number
      domain?: string
      url?: string
      title?: string
      items?: Array<{
        title?: string
        question?: string
        type?: string
      }>
    }>

    for (const it of serpItems) {
      const type = it.type
      if (!type) continue
      if (type === "organic") {
        if (!it.domain || !it.url) continue
        if (serpRows.length >= 10) continue
        serpRows.push({
          position: it.rank_absolute ?? serpRows.length + 1,
          domain: it.domain,
          url: it.url,
          title: it.title ?? null,
          rank: null,
          is_user_domain: userDomain ? domainMatches(it.domain, userDomain) : false,
        })
      } else {
        serpFeatures.add(type)
        if (type === "people_also_ask" && Array.isArray(it.items)) {
          for (const q of it.items) {
            const text = q.title ?? q.question
            if (text && !paa.includes(text)) paa.push(text)
          }
        }
      }
    }

    // ── Bulk-rank join: backlinks/bulk_ranks/live for the 10 SERP domains.
    //   Returns one item per target with the `rank` integer used by the
    //   spec's "Rank 712" column. Cheaper than calling backlinks/summary
    //   per row.
    let bulkRanksEnv: unknown = null
    if (serpRows.length > 0) {
      const uniqueTargets = Array.from(new Set(serpRows.map((r) => r.domain)))
      bulkRanksEnv = await dfs("/v3/backlinks/bulk_ranks/live", [
        { targets: uniqueTargets },
      ]).catch(() => null)
      if (bulkRanksEnv) {
        const ranksByDomain = new Map<string, number>()
        for (const raw of dfsItems<{
          target?: string
          rank?: number | null
        }>(bulkRanksEnv)) {
          if (raw.target && typeof raw.rank === "number") {
            ranksByDomain.set(raw.target.toLowerCase(), raw.rank)
          }
        }
        for (const row of serpRows) {
          row.rank = ranksByDomain.get(row.domain.toLowerCase()) ?? null
        }
      }
    }

    // ── Related + phrase-match keyword lists ─────────────────────────────
    const related: RelatedRow[] = []
    for (const raw of dfsItems<{
      keyword_data?: {
        keyword?: string
        keyword_info?: { search_volume?: number | null }
      }
    }>(relatedEnv)) {
      const kw = raw.keyword_data?.keyword
      if (!kw) continue
      if (kw.toLowerCase() === input.keyword.toLowerCase()) continue
      related.push({
        keyword: kw,
        volume: raw.keyword_data?.keyword_info?.search_volume ?? null,
      })
      if (related.length >= 5) break
    }

    const phraseMatch: RelatedRow[] = []
    for (const raw of dfsItems<{
      keyword?: string
      keyword_info?: { search_volume?: number | null }
    }>(phraseEnv)) {
      if (!raw.keyword) continue
      if (raw.keyword.toLowerCase() === input.keyword.toLowerCase()) continue
      phraseMatch.push({
        keyword: raw.keyword,
        volume: raw.keyword_info?.search_volume ?? null,
      })
      if (phraseMatch.length >= 5) break
    }

    return {
      data: {
        keyword: input.keyword,
        user_domain: userDomain,
        markets,
        kpis,
        trend,
        city_volumes: cityVolumes,
        serp: serpRows,
        serp_features: Array.from(serpFeatures),
        paa,
        related,
        phrase_match: phraseMatch,
      },
      endpoints: [
        "/v3/dataforseo_labs/google/keyword_overview/live",
        "/v3/dataforseo_labs/google/historical_keyword_data/live",
        ...(intentEnv ? ["/v3/dataforseo_labs/google/search_intent/live"] : []),
        "/v3/keywords_data/google_ads/search_volume/live",
        "/v3/serp/google/organic/live/advanced",
        "/v3/dataforseo_labs/google/related_keywords/live",
        "/v3/dataforseo_labs/google/keyword_suggestions/live",
        ...(bulkRanksEnv ? ["/v3/backlinks/bulk_ranks/live"] : []),
      ],
      costUsd: dfsCost(
        overviewEnv,
        historicalEnv,
        intentEnv,
        serpEnv,
        relatedEnv,
        phraseEnv,
        bulkRanksEnv,
        ...adsEnvs,
      ),
    }
  })
}
