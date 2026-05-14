import { z } from "zod"
import { runTool } from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const Input = z.object({
  keywords: z.array(z.string().min(1)).min(2).max(50),
})

type Row = {
  keyword: string
  mentions: number | null
  share_of_voice: number | null
  avg_position: number | null
}

export async function POST(request: Request) {
  return runTool<typeof Input, Row>(request, Input, async (input, { dfs }) => {
    const body = [{ keywords: input.keywords }]
    const env = (await dfs(
      "/v3/ai_optimization/llm_mentions/cross_aggregated_metrics/live",
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
        keyword?: string
        mentions_count?: number | null
        share_of_voice?: number | null
        avg_position?: number | null
      }
      return {
        keyword: it.keyword ?? "",
        mentions: it.mentions_count ?? null,
        share_of_voice: it.share_of_voice ?? null,
        avg_position: it.avg_position ?? null,
      }
    })
    return {
      rows,
      endpoints: [
        "/v3/ai_optimization/llm_mentions/cross_aggregated_metrics/live",
      ],
      costUsd: env.cost,
    }
  })
}
