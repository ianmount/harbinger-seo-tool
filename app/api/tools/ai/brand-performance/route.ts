import { z } from "zod"
import { runTool } from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const Input = z.object({
  keyword: z.string().min(1),
})

type Row = {
  metric: string
  value: number | null
}

export async function POST(request: Request) {
  return runTool<typeof Input, Row>(request, Input, async (input, { dfs }) => {
    const body = [{ keyword: input.keyword }]
    const env = (await dfs(
      "/v3/ai_optimization/llm_mentions/aggregated_metrics/live",
      body,
    )) as {
      cost?: number
      tasks?: { result?: { items?: unknown[] }[] }[]
    }
    const items =
      env.tasks?.flatMap((t) => t.result?.flatMap((r) => r.items ?? []) ?? []) ??
      []

    const rows: Row[] = []
    for (const item of items) {
      const it = item as Record<string, unknown>
      for (const [k, v] of Object.entries(it)) {
        if (typeof v === "number") {
          rows.push({ metric: k, value: v })
        }
      }
    }
    return {
      rows,
      endpoints: ["/v3/ai_optimization/llm_mentions/aggregated_metrics/live"],
      costUsd: env.cost,
    }
  })
}
