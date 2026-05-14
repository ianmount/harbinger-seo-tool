import { z } from "zod"
import { runTool } from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const Input = z.object({
  keywords: z.array(z.string().min(1)).min(1).max(100),
  location_code: z.number().int().optional(),
  location_name: z.string().optional(),
  language_code: z.string().default("en"),
})

type Row = {
  keyword: string
  search_volume: number | null
  cpc: number | null
  competition_level: string | null
  competition: number | null
  keyword_difficulty: number | null
  main_intent: string | null
}

export async function POST(request: Request) {
  return runTool<typeof Input, Row>(request, Input, async (input, { dfs }) => {
    const body = [
      {
        keywords: input.keywords,
        ...(input.location_code
          ? { location_code: input.location_code, language_code: input.language_code }
          : {
              location_name: input.location_name ?? "United States",
              language_name: "English",
            }),
        include_serp_info: true,
        include_clickstream_data: true,
      },
    ]
    const env = (await dfs(
      "/v3/dataforseo_labs/google/keyword_overview/live",
      body,
    )) as {
      cost?: number
      tasks?: { result?: { items?: unknown[] }[] }[]
    }
    const items =
      env.tasks?.flatMap((t) => t.result?.flatMap((r) => r.items ?? []) ?? []) ??
      []

    const rows: Row[] = items.map((raw) => {
      const item = raw as {
        keyword?: string
        keyword_info?: {
          search_volume?: number | null
          cpc?: number | null
          competition?: number | null
          competition_level?: string | null
        }
        keyword_properties?: {
          keyword_difficulty?: number | null
        }
        search_intent_info?: {
          main_intent?: string | null
        }
      }
      return {
        keyword: item.keyword ?? "",
        search_volume: item.keyword_info?.search_volume ?? null,
        cpc: item.keyword_info?.cpc ?? null,
        competition: item.keyword_info?.competition ?? null,
        competition_level: item.keyword_info?.competition_level ?? null,
        keyword_difficulty:
          item.keyword_properties?.keyword_difficulty ?? null,
        main_intent: item.search_intent_info?.main_intent ?? null,
      }
    })

    return {
      rows,
      endpoints: ["/v3/dataforseo_labs/google/keyword_overview/live"],
      costUsd: env.cost,
    }
  })
}
