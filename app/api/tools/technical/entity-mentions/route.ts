import { z } from "zod"
import { dfsCost, dfsItems, runTool } from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 90

const Input = z.object({
  keyword: z.string().min(1),
  limit: z.number().int().min(1).max(1000).default(100),
})

type WebRow = {
  url: string
  title: string | null
  date: string | null
  domain_rank: number | null
}

type LlmRow = {
  llm: string | null
  prompt: string | null
  brand_position: number | null
  total_brands_mentioned: number | null
  date: string | null
}

type AggregatedRow = {
  metric: string
  value: number | string | null
}

type Data = {
  web: WebRow[]
  llm: LlmRow[]
  aggregated: AggregatedRow[]
}

export async function POST(request: Request) {
  return runTool<typeof Input, Data>(request, Input, async (input, { dfs }) => {
    const searchBody = [{ keyword: input.keyword, limit: input.limit }]
    const llmBody = [{ keyword: input.keyword, limit: input.limit }]
    const aggBody = [{ keyword: input.keyword }]

    const [webEnv, llmEnv, aggEnv] = await Promise.all([
      dfs("/v3/content_analysis/search/live", searchBody),
      dfs("/v3/ai_optimization/llm_mentions/search/live", llmBody),
      dfs(
        "/v3/ai_optimization/llm_mentions/aggregated_metrics/live",
        aggBody,
      ),
    ])

    const web: WebRow[] = dfsItems<{
      url?: string
      page_title?: string | null
      date?: string | null
      domain_info?: { rank?: number | null }
    }>(webEnv).map((it) => ({
      url: it.url ?? "",
      title: it.page_title ?? null,
      date: it.date ?? null,
      domain_rank: it.domain_info?.rank ?? null,
    }))

    const llm: LlmRow[] = dfsItems<{
      llm_provider?: string | null
      llm_model?: string | null
      prompt?: string | null
      brand_position?: number | null
      total_brands_mentioned?: number | null
      date?: string | null
    }>(llmEnv).map((it) => ({
      llm: it.llm_model ?? it.llm_provider ?? null,
      prompt: it.prompt ?? null,
      brand_position: it.brand_position ?? null,
      total_brands_mentioned: it.total_brands_mentioned ?? null,
      date: it.date ?? null,
    }))

    const aggregated: AggregatedRow[] = []
    for (const item of dfsItems<Record<string, unknown>>(aggEnv)) {
      for (const [k, v] of Object.entries(item)) {
        if (typeof v === "number" || typeof v === "string") {
          aggregated.push({ metric: k, value: v })
        }
      }
    }

    return {
      data: { web, llm, aggregated },
      endpoints: [
        "/v3/content_analysis/search/live",
        "/v3/ai_optimization/llm_mentions/search/live",
        "/v3/ai_optimization/llm_mentions/aggregated_metrics/live",
      ],
      costUsd: dfsCost(webEnv, llmEnv, aggEnv),
    }
  })
}
