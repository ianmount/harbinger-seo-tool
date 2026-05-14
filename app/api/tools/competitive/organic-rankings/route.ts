import { z } from "zod"
import { dfsCost, dfsItems, locationFields, runTool } from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const Input = z.object({
  target: z.string().min(3),
  location_code: z.number().int().optional(),
  location_name: z.string().optional(),
  language_code: z.string().default("en"),
  limit: z.number().int().min(1).max(1000).default(200),
})

const SERP_SAMPLE_CAP = 25

type RankedRow = {
  keyword: string
  labs_position: number | null
  live_position: number | null
  search_volume: number | null
  cpc: number | null
  url: string | null
  etv: number | null
}

type HistoryRow = {
  date: string
  organic_count: number | null
  organic_etv: number | null
  paid_count: number | null
  paid_etv: number | null
}

type RelevantPageRow = {
  url: string
  keywords_count: number | null
  etv: number | null
}

type Data = {
  ranked: RankedRow[]
  history: HistoryRow[]
  relevantPages: RelevantPageRow[]
}

function rootDomain(target: string): string {
  return target
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .toLowerCase()
}

export async function POST(request: Request) {
  return runTool<typeof Input, Data>(request, Input, async (input, { dfs }) => {
    const loc = locationFields(input)

    const rankedBody = [
      {
        target: input.target,
        ...loc,
        limit: input.limit,
        load_rank_absolute: true,
      },
    ]
    const historyBody = [{ target: input.target, ...loc }]
    const pagesBody = [
      { target: input.target, ...loc, limit: input.limit },
    ]

    const [rankedEnv, historyEnv, pagesEnv] = await Promise.all([
      dfs("/v3/dataforseo_labs/google/ranked_keywords/live", rankedBody),
      dfs(
        "/v3/dataforseo_labs/google/historical_rank_overview/live",
        historyBody,
      ),
      dfs("/v3/dataforseo_labs/google/relevant_pages/live", pagesBody),
    ])

    const rankedRaw = dfsItems<{
      keyword_data?: {
        keyword?: string
        keyword_info?: { search_volume?: number | null; cpc?: number | null }
      }
      ranked_serp_element?: {
        serp_item?: {
          rank_absolute?: number | null
          url?: string | null
          etv?: number | null
        }
      }
    }>(rankedEnv)

    const ranked: RankedRow[] = rankedRaw.map((it) => ({
      keyword: it.keyword_data?.keyword ?? "",
      labs_position: it.ranked_serp_element?.serp_item?.rank_absolute ?? null,
      live_position: null,
      search_volume: it.keyword_data?.keyword_info?.search_volume ?? null,
      cpc: it.keyword_data?.keyword_info?.cpc ?? null,
      url: it.ranked_serp_element?.serp_item?.url ?? null,
      etv: it.ranked_serp_element?.serp_item?.etv ?? null,
    }))

    // Live SERP verification for top-N ranked keywords (by Labs position).
    const serpSample = ranked
      .filter((r) => r.keyword && r.labs_position != null)
      .sort((a, b) => (a.labs_position ?? 999) - (b.labs_position ?? 999))
      .slice(0, SERP_SAMPLE_CAP)
    let serpEnv: unknown = null
    if (serpSample.length > 0) {
      const serpBody = serpSample.map((r) => ({
        keyword: r.keyword,
        ...loc,
        depth: 50,
      }))
      serpEnv = await dfs("/v3/serp/google/organic/live/advanced", serpBody, {
        timeoutMs: 120_000,
      }).catch(() => null)
      if (serpEnv) {
        const targetRoot = rootDomain(input.target)
        const livePosByKeyword = new Map<string, number>()
        const env = serpEnv as {
          tasks?: {
            data?: { keyword?: string }
            result?: {
              keyword?: string
              items?: {
                type?: string
                domain?: string
                rank_absolute?: number
              }[]
            }[]
          }[]
        }
        for (const task of env.tasks ?? []) {
          const keyword = task.data?.keyword ?? task.result?.[0]?.keyword
          if (!keyword) continue
          for (const r of task.result ?? []) {
            for (const it of r.items ?? []) {
              if (it.type !== "organic") continue
              if (!it.domain) continue
              if (rootDomain(it.domain) === targetRoot) {
                if (
                  !livePosByKeyword.has(keyword) ||
                  (it.rank_absolute ?? 999) < (livePosByKeyword.get(keyword) ?? 999)
                ) {
                  livePosByKeyword.set(keyword, it.rank_absolute ?? 999)
                }
              }
            }
          }
        }
        for (const r of ranked) {
          const live = livePosByKeyword.get(r.keyword)
          if (live != null) r.live_position = live
        }
      }
    }

    const history: HistoryRow[] = []
    for (const item of dfsItems<{
      items?: {
        date?: string
        metrics?: {
          organic?: { count?: number; etv?: number }
          paid?: { count?: number; etv?: number }
        }
      }[]
    }>(historyEnv)) {
      for (const h of item.items ?? []) {
        if (!h.date) continue
        history.push({
          date: h.date.slice(0, 10),
          organic_count: h.metrics?.organic?.count ?? null,
          organic_etv: h.metrics?.organic?.etv ?? null,
          paid_count: h.metrics?.paid?.count ?? null,
          paid_etv: h.metrics?.paid?.etv ?? null,
        })
      }
    }

    const relevantPages: RelevantPageRow[] = dfsItems<{
      page_address?: string
      url?: string
      metrics?: { organic?: { count?: number; etv?: number } }
    }>(pagesEnv).map((it) => ({
      url: it.page_address ?? it.url ?? "",
      keywords_count: it.metrics?.organic?.count ?? null,
      etv: it.metrics?.organic?.etv ?? null,
    }))

    return {
      data: { ranked, history, relevantPages },
      endpoints: [
        "/v3/dataforseo_labs/google/ranked_keywords/live",
        "/v3/dataforseo_labs/google/historical_rank_overview/live",
        "/v3/dataforseo_labs/google/relevant_pages/live",
        ...(serpEnv ? ["/v3/serp/google/organic/live/advanced"] : []),
      ],
      costUsd: dfsCost(rankedEnv, historyEnv, pagesEnv, serpEnv),
    }
  })
}
