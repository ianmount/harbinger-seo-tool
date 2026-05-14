import { z } from "zod"
import { runTool } from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const Input = z.object({
  keyword: z.string().min(1),
})

type Row = {
  group: string
  label: string
  value: number | null
}

export async function POST(request: Request) {
  return runTool<typeof Input, Row>(request, Input, async (input, { dfs }) => {
    const body = [{ keyword: input.keyword }]
    const [topDomains, topPages, aggregated] = (await Promise.all([
      dfs("/v3/ai_optimization/llm_mentions/top_domains/live", body),
      dfs("/v3/ai_optimization/llm_mentions/top_pages/live", body),
      dfs("/v3/ai_optimization/llm_mentions/aggregated_metrics/live", body),
    ])) as Array<{
      cost?: number
      tasks?: { result?: { items?: unknown[] }[] }[]
    }>

    const rows: Row[] = []

    for (const t of topDomains.tasks ?? []) {
      for (const r of t.result ?? []) {
        for (const raw of r.items ?? []) {
          const it = raw as { domain?: string; mentions_count?: number | null }
          rows.push({
            group: "Top Domain",
            label: it.domain ?? "",
            value: it.mentions_count ?? null,
          })
        }
      }
    }
    for (const t of topPages.tasks ?? []) {
      for (const r of t.result ?? []) {
        for (const raw of r.items ?? []) {
          const it = raw as { url?: string; mentions_count?: number | null }
          rows.push({
            group: "Top Page",
            label: it.url ?? "",
            value: it.mentions_count ?? null,
          })
        }
      }
    }
    for (const t of aggregated.tasks ?? []) {
      for (const r of t.result ?? []) {
        for (const raw of r.items ?? []) {
          const it = raw as Record<string, unknown>
          for (const [k, v] of Object.entries(it)) {
            if (typeof v === "number") {
              rows.push({ group: "Aggregated", label: k, value: v })
            }
          }
        }
      }
    }

    return {
      rows,
      endpoints: [
        "/v3/ai_optimization/llm_mentions/top_domains/live",
        "/v3/ai_optimization/llm_mentions/top_pages/live",
        "/v3/ai_optimization/llm_mentions/aggregated_metrics/live",
      ],
      costUsd:
        (topDomains.cost ?? 0) + (topPages.cost ?? 0) + (aggregated.cost ?? 0),
    }
  })
}
