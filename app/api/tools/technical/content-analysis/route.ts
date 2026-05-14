import { z } from "zod"
import { runTool } from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const Input = z.object({
  keyword: z.string().min(1),
  limit: z.number().int().min(1).max(1000).default(100),
})

type Row = {
  url: string
  title: string | null
  date: string | null
  domain_rank: number | null
  sentiment_score: number | null
  language: string | null
}

export async function POST(request: Request) {
  return runTool<typeof Input, Row>(request, Input, async (input, { dfs }) => {
    const body = [
      {
        keyword: input.keyword,
        limit: input.limit,
        page_type: "ANY",
      },
    ]
    const env = (await dfs("/v3/content_analysis/search/live", body)) as {
      cost?: number
      tasks?: { result?: { items?: unknown[] }[] }[]
    }
    const items =
      env.tasks?.flatMap((t) => t.result?.flatMap((r) => r.items ?? []) ?? []) ??
      []
    const rows: Row[] = items.map((raw) => {
      const it = raw as {
        url?: string
        page_title?: string | null
        page_summary?: string | null
        date?: string | null
        domain_info?: { rank?: number | null }
        sentiment_connotations?: { positive?: number; negative?: number }
        sentiment_polarity?: { positive?: number; negative?: number }
        sentiment_score?: number | null
        language?: string | null
      }
      const score =
        typeof it.sentiment_score === "number"
          ? it.sentiment_score
          : it.sentiment_polarity
            ? (it.sentiment_polarity.positive ?? 0) -
              (it.sentiment_polarity.negative ?? 0)
            : null
      return {
        url: it.url ?? "",
        title: it.page_title ?? null,
        date: it.date ?? null,
        domain_rank: it.domain_info?.rank ?? null,
        sentiment_score: score,
        language: it.language ?? null,
      }
    })
    return {
      rows,
      endpoints: ["/v3/content_analysis/search/live"],
      costUsd: env.cost,
    }
  })
}
