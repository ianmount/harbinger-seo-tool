import { z } from "zod"
import { runTool } from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const Input = z.object({
  seed: z.string().min(1),
  location_code: z.number().int().optional(),
  location_name: z.string().optional(),
  language_code: z.string().default("en"),
  limit: z.number().int().min(1).max(1000).default(200),
})

type Row = {
  keyword: string
  search_volume: number | null
  cpc: number | null
  competition_level: string | null
  keyword_difficulty: number | null
}

function locationFields(input: z.infer<typeof Input>) {
  return input.location_code
    ? { location_code: input.location_code, language_code: input.language_code }
    : {
        location_name: input.location_name ?? "United States",
        language_name: "English",
      }
}

function mapItem(raw: unknown): Row {
  const item = raw as {
    keyword?: string
    keyword_info?: {
      search_volume?: number | null
      cpc?: number | null
      competition_level?: string | null
    }
    keyword_properties?: { keyword_difficulty?: number | null }
  }
  return {
    keyword: item.keyword ?? "",
    search_volume: item.keyword_info?.search_volume ?? null,
    cpc: item.keyword_info?.cpc ?? null,
    competition_level: item.keyword_info?.competition_level ?? null,
    keyword_difficulty: item.keyword_properties?.keyword_difficulty ?? null,
  }
}

export async function POST(request: Request) {
  return runTool<typeof Input, Row>(request, Input, async (input, { dfs }) => {
    const body = [
      {
        keyword: input.seed,
        ...locationFields(input),
        limit: input.limit,
        include_serp_info: true,
      },
    ]
    const env = (await dfs(
      "/v3/dataforseo_labs/google/keyword_suggestions/live",
      body,
    )) as {
      cost?: number
      tasks?: { result?: { items?: unknown[] }[] }[]
    }
    const items =
      env.tasks?.flatMap((t) => t.result?.flatMap((r) => r.items ?? []) ?? []) ??
      []
    const rows = items.map(mapItem)
    return {
      rows,
      endpoints: ["/v3/dataforseo_labs/google/keyword_suggestions/live"],
      costUsd: env.cost,
    }
  })
}
