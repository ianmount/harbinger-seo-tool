import { z } from "zod"
import { runTool } from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const Input = z.object({
  target: z.string().min(3),
  location_code: z.number().int().optional(),
  location_name: z.string().optional(),
  language_code: z.string().default("en"),
  limit: z.number().int().min(1).max(1000).default(200),
})

type Row = {
  keyword: string
  position: number | null
  search_volume: number | null
  cpc: number | null
  url: string | null
  etv: number | null
}

export async function POST(request: Request) {
  return runTool<typeof Input, Row>(request, Input, async (input, { dfs }) => {
    const locFields = input.location_code
      ? { location_code: input.location_code, language_code: input.language_code }
      : {
          location_name: input.location_name ?? "United States",
          language_name: "English",
        }

    const body = [
      {
        target: input.target,
        ...locFields,
        limit: input.limit,
        load_rank_absolute: true,
      },
    ]
    const env = (await dfs(
      "/v3/dataforseo_labs/google/ranked_keywords/live",
      body,
    )) as {
      cost?: number
      tasks?: { result?: { items?: unknown[] }[] }[]
    }
    const items =
      env.tasks?.flatMap((t) => t.result?.flatMap((r) => r.items ?? []) ?? []) ??
      []
    const rows: Row[] = items.map((raw) => {
      const it = raw as {
        keyword_data?: {
          keyword?: string
          keyword_info?: { search_volume?: number | null; cpc?: number | null }
        }
        ranked_serp_element?: {
          serp_item?: {
            rank_group?: number | null
            rank_absolute?: number | null
            url?: string | null
            etv?: number | null
          }
        }
      }
      return {
        keyword: it.keyword_data?.keyword ?? "",
        position: it.ranked_serp_element?.serp_item?.rank_absolute ?? null,
        search_volume: it.keyword_data?.keyword_info?.search_volume ?? null,
        cpc: it.keyword_data?.keyword_info?.cpc ?? null,
        url: it.ranked_serp_element?.serp_item?.url ?? null,
        etv: it.ranked_serp_element?.serp_item?.etv ?? null,
      }
    })
    return {
      rows,
      endpoints: ["/v3/dataforseo_labs/google/ranked_keywords/live"],
      costUsd: env.cost,
    }
  })
}
