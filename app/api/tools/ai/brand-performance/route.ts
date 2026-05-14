import { z } from "zod"
import { dfsCost, dfsItems, runTool } from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const Input = z.object({
  keyword: z.string().min(1),
})

type MetricRow = { metric: string; value: number | string | null }
type MentionRow = {
  llm: string | null
  prompt: string | null
  brand_position: number | null
  total_brands_mentioned: number | null
  date: string | null
}

type Data = {
  metrics: MetricRow[]
  mentions: MentionRow[]
}

export async function POST(request: Request) {
  return runTool<typeof Input, Data>(request, Input, async (input, { dfs }) => {
    const body = [{ keyword: input.keyword }]
    const mentionsBody = [{ keyword: input.keyword, limit: 200 }]

    const [aggEnv, mentionsEnv] = await Promise.all([
      dfs("/v3/ai_optimization/llm_mentions/aggregated_metrics/live", body),
      dfs("/v3/ai_optimization/llm_mentions/search/live", mentionsBody),
    ])

    const metrics: MetricRow[] = []
    for (const item of dfsItems<Record<string, unknown>>(aggEnv)) {
      for (const [k, v] of Object.entries(item)) {
        if (typeof v === "number" || typeof v === "string") {
          metrics.push({ metric: k, value: v })
        }
      }
    }

    const mentions: MentionRow[] = dfsItems<{
      llm_provider?: string | null
      llm_model?: string | null
      prompt?: string | null
      brand_position?: number | null
      total_brands_mentioned?: number | null
      date?: string | null
    }>(mentionsEnv).map((it) => ({
      llm: it.llm_model ?? it.llm_provider ?? null,
      prompt: it.prompt ?? null,
      brand_position: it.brand_position ?? null,
      total_brands_mentioned: it.total_brands_mentioned ?? null,
      date: it.date ?? null,
    }))

    return {
      data: { metrics, mentions },
      endpoints: [
        "/v3/ai_optimization/llm_mentions/aggregated_metrics/live",
        "/v3/ai_optimization/llm_mentions/search/live",
      ],
      costUsd: dfsCost(aggEnv, mentionsEnv),
    }
  })
}
