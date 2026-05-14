import { z } from "zod"
import { dfsCost, dfsItems, runTool } from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 90

const Input = z.object({
  keyword: z.string().min(1),
})

type StatRow = { category: string; bucket: string; value: number | null }
type TrendRow = { date: string; phrase: string; value: number | null }

type Data = { stats: StatRow[]; trends: TrendRow[] }

export async function POST(request: Request) {
  return runTool<typeof Input, Data>(request, Input, async (input, { dfs }) => {
    const body = [{ keyword: input.keyword }]

    const [sentimentEnv, ratingEnv, phraseEnv] = await Promise.all([
      dfs("/v3/content_analysis/sentiment_analysis/live", body),
      dfs("/v3/content_analysis/rating_distribution/live", body),
      dfs("/v3/content_analysis/phrase_trends/live", body).catch(() => null),
    ])

    const stats: StatRow[] = []
    for (const task of (
      sentimentEnv as { tasks?: { result?: unknown[] }[] }
    ).tasks ?? []) {
      for (const r of task.result ?? []) {
        const obj = r as { sentiment_connotations?: Record<string, number> }
        for (const [bucket, value] of Object.entries(
          obj.sentiment_connotations ?? {},
        )) {
          stats.push({ category: "Sentiment", bucket, value })
        }
      }
    }
    for (const task of (ratingEnv as { tasks?: { result?: unknown[] }[] }).tasks ??
      []) {
      for (const r of task.result ?? []) {
        const obj = r as { rating_distribution?: Record<string, number> }
        for (const [bucket, value] of Object.entries(
          obj.rating_distribution ?? {},
        )) {
          stats.push({ category: "Rating", bucket: `${bucket}★`, value })
        }
      }
    }

    const trends: TrendRow[] = phraseEnv
      ? dfsItems<{
          phrase?: string
          date?: string
          citations_count?: number
        }>(phraseEnv)
          .filter((it) => it.date && it.phrase)
          .map((it) => ({
            date: (it.date ?? "").slice(0, 10),
            phrase: it.phrase ?? "",
            value: it.citations_count ?? null,
          }))
      : []

    return {
      data: { stats, trends },
      endpoints: [
        "/v3/content_analysis/sentiment_analysis/live",
        "/v3/content_analysis/rating_distribution/live",
        ...(phraseEnv ? ["/v3/content_analysis/phrase_trends/live"] : []),
      ],
      costUsd: dfsCost(sentimentEnv, ratingEnv, phraseEnv),
    }
  })
}
