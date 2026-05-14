import { z } from "zod"
import { dfsCost, dfsItems, locationFields, runTool } from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const Input = z.object({
  keywords: z.array(z.string().min(1)).min(1).max(100),
  location_code: z.number().int().optional(),
  location_name: z.string().optional(),
  language_code: z.string().default("en"),
})

const SERP_SAMPLE_CAP = 25

type KeywordRow = {
  keyword: string
  labs_volume: number | null
  ads_volume: number | null
  cpc: number | null
  competition_level: string | null
  keyword_difficulty: number | null
  main_intent: string | null
  serp_top_domain: string | null
}

type SerpRow = {
  keyword: string
  position: number
  domain: string
  url: string
  title: string | null
}

type MonthlyRow = {
  keyword: string
  date: string
  search_volume: number | null
}

type Data = {
  keywords: KeywordRow[]
  serp: SerpRow[]
  monthly: MonthlyRow[]
}

export async function POST(request: Request) {
  return runTool<typeof Input, Data>(request, Input, async (input, { dfs }) => {
    const loc = locationFields(input)

    // 4 batched calls — each takes the full keyword list in one task.
    // SERP advanced is per-keyword and run separately on the first N.
    const overviewBody = [
      { keywords: input.keywords, ...loc, include_serp_info: true },
    ]
    const historicalBody = [{ keywords: input.keywords, ...loc }]
    const intentBody = [
      {
        keywords: input.keywords,
        ...(input.location_code
          ? { language_code: input.language_code }
          : { language_name: "English" }),
      },
    ]
    const adsBody = [{ keywords: input.keywords, ...loc }]

    const serpKeywords = input.keywords.slice(0, SERP_SAMPLE_CAP)
    const serpBody = serpKeywords.map((kw) => ({
      keyword: kw,
      ...loc,
      depth: 10,
    }))

    const [overviewEnv, historicalEnv, intentEnv, adsEnv, serpEnv] =
      await Promise.all([
        dfs("/v3/dataforseo_labs/google/keyword_overview/live", overviewBody),
        dfs(
          "/v3/dataforseo_labs/google/historical_keyword_data/live",
          historicalBody,
        ),
        dfs(
          "/v3/dataforseo_labs/google/search_intent/live",
          intentBody,
        ).catch(() => null),
        dfs("/v3/keywords_data/google_ads/search_volume/live", adsBody),
        serpBody.length > 0
          ? dfs("/v3/serp/google/organic/live/advanced", serpBody, {
              timeoutMs: 120_000,
            })
          : Promise.resolve(null),
      ])

    // Build lookup maps so we can merge by keyword.
    const intentByKeyword = new Map<string, string>()
    if (intentEnv) {
      for (const raw of dfsItems<{
        keyword?: string
        keyword_intent?: { label?: string }
      }>(intentEnv)) {
        if (raw.keyword && raw.keyword_intent?.label) {
          intentByKeyword.set(raw.keyword, raw.keyword_intent.label)
        }
      }
    }

    const adsByKeyword = new Map<
      string,
      { volume: number | null; cpc: number | null }
    >()
    for (const raw of dfsItems<{
      keyword?: string
      search_volume?: number | null
      cpc?: number | null
    }>(adsEnv)) {
      if (raw.keyword) {
        adsByKeyword.set(raw.keyword, {
          volume: raw.search_volume ?? null,
          cpc: raw.cpc ?? null,
        })
      }
    }

    const serpRows: SerpRow[] = []
    const topSerpByKeyword = new Map<string, string>()
    if (serpEnv) {
      const env = serpEnv as {
        tasks?: {
          data?: { keyword?: string }
          result?: {
            keyword?: string
            items?: {
              type?: string
              rank_absolute?: number
              domain?: string
              url?: string
              title?: string
            }[]
          }[]
        }[]
      }
      for (const task of env.tasks ?? []) {
        const taskKeyword = task.data?.keyword ?? task.result?.[0]?.keyword
        for (const r of task.result ?? []) {
          const keyword = taskKeyword ?? r.keyword ?? ""
          for (const it of r.items ?? []) {
            if (it.type !== "organic") continue
            if (!it.domain || !it.url) continue
            const row: SerpRow = {
              keyword,
              position: it.rank_absolute ?? 0,
              domain: it.domain,
              url: it.url,
              title: it.title ?? null,
            }
            serpRows.push(row)
            if (!topSerpByKeyword.has(keyword) && row.position <= 1) {
              topSerpByKeyword.set(keyword, row.domain)
            }
          }
        }
      }
    }

    const keywords: KeywordRow[] = []
    for (const raw of dfsItems<{
      keyword?: string
      keyword_info?: {
        search_volume?: number | null
        cpc?: number | null
        competition_level?: string | null
      }
      keyword_properties?: { keyword_difficulty?: number | null }
      search_intent_info?: { main_intent?: string | null }
    }>(overviewEnv)) {
      if (!raw.keyword) continue
      const ads = adsByKeyword.get(raw.keyword)
      keywords.push({
        keyword: raw.keyword,
        labs_volume: raw.keyword_info?.search_volume ?? null,
        ads_volume: ads?.volume ?? null,
        cpc: ads?.cpc ?? raw.keyword_info?.cpc ?? null,
        competition_level: raw.keyword_info?.competition_level ?? null,
        keyword_difficulty: raw.keyword_properties?.keyword_difficulty ?? null,
        main_intent:
          intentByKeyword.get(raw.keyword) ??
          raw.search_intent_info?.main_intent ??
          null,
        serp_top_domain: topSerpByKeyword.get(raw.keyword) ?? null,
      })
    }

    // Historical monthly volume — one row per keyword × month.
    const monthly: MonthlyRow[] = []
    for (const raw of dfsItems<{
      keyword?: string
      history?: {
        year?: number
        month?: number
        search_volume?: number | null
      }[]
    }>(historicalEnv)) {
      if (!raw.keyword) continue
      for (const h of raw.history ?? []) {
        if (h.year == null || h.month == null) continue
        const mm = String(h.month).padStart(2, "0")
        monthly.push({
          keyword: raw.keyword,
          date: `${h.year}-${mm}`,
          search_volume: h.search_volume ?? null,
        })
      }
    }
    monthly.sort((a, b) =>
      a.keyword === b.keyword
        ? a.date.localeCompare(b.date)
        : a.keyword.localeCompare(b.keyword),
    )

    return {
      data: { keywords, serp: serpRows, monthly },
      endpoints: [
        "/v3/dataforseo_labs/google/keyword_overview/live",
        "/v3/dataforseo_labs/google/historical_keyword_data/live",
        ...(intentEnv ? ["/v3/dataforseo_labs/google/search_intent/live"] : []),
        "/v3/keywords_data/google_ads/search_volume/live",
        ...(serpEnv ? ["/v3/serp/google/organic/live/advanced"] : []),
      ],
      costUsd: dfsCost(
        overviewEnv,
        historicalEnv,
        intentEnv,
        adsEnv,
        serpEnv,
      ),
    }
  })
}
