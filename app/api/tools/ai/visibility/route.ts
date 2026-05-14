import { z } from "zod"
import { dfsCost, dfsItems, runTool } from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const Input = z.object({ keyword: z.string().min(1) })

type AggregatedRow = { metric: string; value: number | string | null }
type DomainRow = { domain: string; mentions: number | null }
type PageRow = { url: string; mentions: number | null }

type Data = {
  aggregated: AggregatedRow[]
  topDomains: DomainRow[]
  topPages: PageRow[]
}

export async function POST(request: Request) {
  return runTool<typeof Input, Data>(request, Input, async (input, { dfs }) => {
    const body = [{ keyword: input.keyword }]

    const [aggEnv, domainsEnv, pagesEnv] = await Promise.all([
      dfs("/v3/ai_optimization/llm_mentions/aggregated_metrics/live", body),
      dfs("/v3/ai_optimization/llm_mentions/top_domains/live", body),
      dfs("/v3/ai_optimization/llm_mentions/top_pages/live", body),
    ])

    const aggregated: AggregatedRow[] = []
    for (const item of dfsItems<Record<string, unknown>>(aggEnv)) {
      for (const [k, v] of Object.entries(item)) {
        if (typeof v === "number" || typeof v === "string") {
          aggregated.push({ metric: k, value: v })
        }
      }
    }

    const topDomains: DomainRow[] = dfsItems<{
      domain?: string
      mentions_count?: number | null
    }>(domainsEnv).map((it) => ({
      domain: it.domain ?? "",
      mentions: it.mentions_count ?? null,
    }))

    const topPages: PageRow[] = dfsItems<{
      url?: string
      mentions_count?: number | null
    }>(pagesEnv).map((it) => ({
      url: it.url ?? "",
      mentions: it.mentions_count ?? null,
    }))

    return {
      data: { aggregated, topDomains, topPages },
      endpoints: [
        "/v3/ai_optimization/llm_mentions/aggregated_metrics/live",
        "/v3/ai_optimization/llm_mentions/top_domains/live",
        "/v3/ai_optimization/llm_mentions/top_pages/live",
      ],
      costUsd: dfsCost(aggEnv, domainsEnv, pagesEnv),
    }
  })
}
