import { z } from "zod"
import { dfsCost, dfsItems, locationFields, runTool } from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const Input = z.object({
  seed: z.string().min(1),
  location_code: z.number().int().optional(),
  location_name: z.string().optional(),
  language_code: z.string().default("en"),
  limit: z.number().int().min(1).max(1000).default(200),
})

type Row = {
  keyword: string
  source: string
  labs_volume: number | null
  ads_volume: number | null
  cpc: number | null
  competition_level: string | null
  keyword_difficulty: number | null
}

type Data = { rows: Row[] }

function extractIdeas(envelope: unknown, source: string): Row[] {
  const rows: Row[] = []
  for (const raw of dfsItems<{
    keyword?: string
    keyword_info?: {
      search_volume?: number | null
      cpc?: number | null
      competition_level?: string | null
    }
    keyword_properties?: { keyword_difficulty?: number | null }
  }>(envelope)) {
    if (!raw.keyword) continue
    rows.push({
      keyword: raw.keyword,
      source,
      labs_volume: raw.keyword_info?.search_volume ?? null,
      ads_volume: null,
      cpc: raw.keyword_info?.cpc ?? null,
      competition_level: raw.keyword_info?.competition_level ?? null,
      keyword_difficulty: raw.keyword_properties?.keyword_difficulty ?? null,
    })
  }
  return rows
}

export async function POST(request: Request) {
  return runTool<typeof Input, Data>(request, Input, async (input, { dfs }) => {
    const loc = locationFields(input)

    const suggestionsBody = [
      { keyword: input.seed, ...loc, limit: input.limit },
    ]
    const ideasBody = [
      { keywords: [input.seed], ...loc, limit: input.limit },
    ]
    const relatedBody = [
      { keyword: input.seed, ...loc, limit: input.limit },
    ]

    const [suggestionsEnv, ideasEnv, relatedEnv] = await Promise.all([
      dfs(
        "/v3/dataforseo_labs/google/keyword_suggestions/live",
        suggestionsBody,
      ),
      dfs("/v3/dataforseo_labs/google/keyword_ideas/live", ideasBody),
      dfs("/v3/dataforseo_labs/google/related_keywords/live", relatedBody),
    ])

    // Merge + dedup by keyword, keeping the first source seen.
    const seen = new Map<string, Row>()
    const order = [
      ...extractIdeas(suggestionsEnv, "suggestion"),
      ...extractIdeas(ideasEnv, "idea"),
      ...extractIdeas(relatedEnv, "related"),
    ]
    for (const row of order) {
      if (!seen.has(row.keyword)) seen.set(row.keyword, row)
    }
    const merged = Array.from(seen.values())

    // Google Ads volume for the dedup'd set (cap at 1000 per task).
    const adsKeywords = merged.slice(0, 1000).map((r) => r.keyword)
    let adsEnv: unknown = null
    if (adsKeywords.length > 0) {
      const adsBody = [{ keywords: adsKeywords, ...loc }]
      adsEnv = await dfs(
        "/v3/keywords_data/google_ads/search_volume/live",
        adsBody,
      )
      const adsMap = new Map<
        string,
        { volume: number | null; cpc: number | null }
      >()
      for (const raw of dfsItems<{
        keyword?: string
        search_volume?: number | null
        cpc?: number | null
      }>(adsEnv)) {
        if (raw.keyword) {
          adsMap.set(raw.keyword, {
            volume: raw.search_volume ?? null,
            cpc: raw.cpc ?? null,
          })
        }
      }
      for (const row of merged) {
        const ads = adsMap.get(row.keyword)
        if (ads) {
          row.ads_volume = ads.volume
          row.cpc = row.cpc ?? ads.cpc
        }
      }
    }

    return {
      data: { rows: merged },
      endpoints: [
        "/v3/dataforseo_labs/google/keyword_suggestions/live",
        "/v3/dataforseo_labs/google/keyword_ideas/live",
        "/v3/dataforseo_labs/google/related_keywords/live",
        "/v3/keywords_data/google_ads/search_volume/live",
      ],
      costUsd: dfsCost(suggestionsEnv, ideasEnv, relatedEnv, adsEnv),
    }
  })
}
