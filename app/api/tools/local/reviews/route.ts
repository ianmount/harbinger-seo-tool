import { z } from "zod"
import { runTool } from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const Input = z.object({
  keyword: z.string().min(1),
})

type Row = {
  bucket: string
  value: number | null
  category: string
}

export async function POST(request: Request) {
  return runTool<typeof Input, Row>(request, Input, async (input, { dfs }) => {
    const body = [{ keyword: input.keyword }]
    const [sentimentEnv, ratingEnv] = (await Promise.all([
      dfs("/v3/content_analysis/sentiment_analysis/live", body),
      dfs("/v3/content_analysis/rating_distribution/live", body),
    ])) as Array<{
      cost?: number
      tasks?: { result?: unknown[] }[]
    }>

    const rows: Row[] = []

    for (const task of sentimentEnv.tasks ?? []) {
      for (const r of task.result ?? []) {
        const obj = r as {
          sentiment_connotations?: Record<string, number>
        }
        for (const [bucket, value] of Object.entries(
          obj.sentiment_connotations ?? {},
        )) {
          rows.push({ category: "Sentiment", bucket, value })
        }
      }
    }
    for (const task of ratingEnv.tasks ?? []) {
      for (const r of task.result ?? []) {
        const obj = r as {
          rating_distribution?: Record<string, number>
        }
        for (const [bucket, value] of Object.entries(
          obj.rating_distribution ?? {},
        )) {
          rows.push({ category: "Rating", bucket: `${bucket}★`, value })
        }
      }
    }

    return {
      rows,
      endpoints: [
        "/v3/content_analysis/sentiment_analysis/live",
        "/v3/content_analysis/rating_distribution/live",
      ],
      costUsd: (sentimentEnv.cost ?? 0) + (ratingEnv.cost ?? 0),
    }
  })
}
