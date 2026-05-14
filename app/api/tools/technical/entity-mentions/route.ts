import { z } from "zod"
import { runTool } from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const Input = z.object({
  keyword: z.string().min(1),
  limit: z.number().int().min(1).max(1000).default(100),
})

type Row = {
  llm: string | null
  prompt: string | null
  brand_position: number | null
  total_brands_mentioned: number | null
  date: string | null
}

export async function POST(request: Request) {
  return runTool<typeof Input, Row>(request, Input, async (input, { dfs }) => {
    const body = [{ keyword: input.keyword, limit: input.limit }]
    const env = (await dfs(
      "/v3/ai_optimization/llm_mentions/search/live",
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
        llm_provider?: string | null
        llm_model?: string | null
        prompt?: string | null
        brand_position?: number | null
        total_brands_mentioned?: number | null
        date?: string | null
      }
      return {
        llm: it.llm_model ?? it.llm_provider ?? null,
        prompt: it.prompt ?? null,
        brand_position: it.brand_position ?? null,
        total_brands_mentioned: it.total_brands_mentioned ?? null,
        date: it.date ?? null,
      }
    })
    return {
      rows,
      endpoints: ["/v3/ai_optimization/llm_mentions/search/live"],
      costUsd: env.cost,
    }
  })
}
