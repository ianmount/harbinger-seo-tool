import { z } from "zod"
import { dfsCost, dfsItems, runTool } from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const Input = z.object({
  keywords: z.array(z.string().min(1)).min(2).max(50),
})

type CompareRow = {
  keyword: string
  mentions: number | null
  share_of_voice: number | null
  avg_position: number | null
}

type PerBrandRow = {
  keyword: string
  metric: string
  value: number | string | null
}

type Data = {
  comparison: CompareRow[]
  perBrand: PerBrandRow[]
}

export async function POST(request: Request) {
  return runTool<typeof Input, Data>(request, Input, async (input, { dfs }) => {
    const crossBody = [{ keywords: input.keywords }]

    const crossEnv = await dfs(
      "/v3/ai_optimization/llm_mentions/cross_aggregated_metrics/live",
      crossBody,
    )

    // Per-brand aggregated metrics in parallel — one task per keyword.
    const perBrandEnvs = await Promise.all(
      input.keywords.map((kw) =>
        dfs(
          "/v3/ai_optimization/llm_mentions/aggregated_metrics/live",
          [{ keyword: kw }],
        ).catch(() => null),
      ),
    )

    const comparison: CompareRow[] = dfsItems<{
      keyword?: string
      mentions_count?: number | null
      share_of_voice?: number | null
      avg_position?: number | null
    }>(crossEnv).map((it) => ({
      keyword: it.keyword ?? "",
      mentions: it.mentions_count ?? null,
      share_of_voice: it.share_of_voice ?? null,
      avg_position: it.avg_position ?? null,
    }))

    const perBrand: PerBrandRow[] = []
    perBrandEnvs.forEach((env, idx) => {
      if (!env) return
      const keyword = input.keywords[idx]
      for (const item of dfsItems<Record<string, unknown>>(env)) {
        for (const [k, v] of Object.entries(item)) {
          if (typeof v === "number" || typeof v === "string") {
            perBrand.push({ keyword, metric: k, value: v })
          }
        }
      }
    })

    return {
      data: { comparison, perBrand },
      endpoints: [
        "/v3/ai_optimization/llm_mentions/cross_aggregated_metrics/live",
        "/v3/ai_optimization/llm_mentions/aggregated_metrics/live",
      ],
      costUsd: dfsCost(crossEnv, ...perBrandEnvs),
    }
  })
}
