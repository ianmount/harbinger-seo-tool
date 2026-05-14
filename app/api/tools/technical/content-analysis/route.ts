import { z } from "zod"
import { dfsCost, dfsItems, runTool } from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 90

const Input = z.object({
  keyword: z.string().min(1),
  limit: z.number().int().min(1).max(1000).default(100),
})

type CitationRow = {
  url: string
  title: string | null
  date: string | null
  domain_rank: number | null
  sentiment_score: number | null
  language: string | null
}

type StatRow = {
  group: string
  metric: string
  value: number | string | null
}

type TrendRow = {
  date: string
  label: string
  value: number | null
  kind: "phrase" | "category"
}

type Data = {
  citations: CitationRow[]
  stats: StatRow[]
  trends: TrendRow[]
}

export async function POST(request: Request) {
  return runTool<typeof Input, Data>(request, Input, async (input, { dfs }) => {
    const body = [{ keyword: input.keyword }]
    const searchBody = [{ keyword: input.keyword, limit: input.limit }]

    const [searchEnv, summaryEnv, sentimentEnv, ratingEnv, phraseEnv, categoryEnv] =
      await Promise.all([
        dfs("/v3/content_analysis/search/live", searchBody),
        dfs("/v3/content_analysis/summary/live", body),
        dfs("/v3/content_analysis/sentiment_analysis/live", body),
        dfs("/v3/content_analysis/rating_distribution/live", body),
        dfs("/v3/content_analysis/phrase_trends/live", body).catch(() => null),
        dfs("/v3/content_analysis/category_trends/live", body).catch(
          () => null,
        ),
      ])

    const citations: CitationRow[] = dfsItems<{
      url?: string
      page_title?: string | null
      date?: string | null
      domain_info?: { rank?: number | null }
      sentiment_polarity?: { positive?: number; negative?: number }
      sentiment_score?: number | null
      language?: string | null
    }>(searchEnv).map((it) => ({
      url: it.url ?? "",
      title: it.page_title ?? null,
      date: it.date ?? null,
      domain_rank: it.domain_info?.rank ?? null,
      sentiment_score:
        typeof it.sentiment_score === "number"
          ? it.sentiment_score
          : it.sentiment_polarity
            ? (it.sentiment_polarity.positive ?? 0) -
              (it.sentiment_polarity.negative ?? 0)
            : null,
      language: it.language ?? null,
    }))

    const stats: StatRow[] = []
    for (const task of (summaryEnv as { tasks?: { result?: unknown[] }[] })
      .tasks ?? []) {
      for (const r of task.result ?? []) {
        const obj = r as Record<string, unknown>
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === "number" || typeof v === "string") {
            stats.push({ group: "Summary", metric: k, value: v })
          }
        }
      }
    }
    for (const task of (sentimentEnv as { tasks?: { result?: unknown[] }[] })
      .tasks ?? []) {
      for (const r of task.result ?? []) {
        const obj = r as { sentiment_connotations?: Record<string, number> }
        for (const [k, v] of Object.entries(obj.sentiment_connotations ?? {})) {
          stats.push({ group: "Sentiment", metric: k, value: v })
        }
      }
    }
    for (const task of (ratingEnv as { tasks?: { result?: unknown[] }[] })
      .tasks ?? []) {
      for (const r of task.result ?? []) {
        const obj = r as { rating_distribution?: Record<string, number> }
        for (const [k, v] of Object.entries(obj.rating_distribution ?? {})) {
          stats.push({ group: "Rating", metric: `${k}★`, value: v })
        }
      }
    }

    const trends: TrendRow[] = []
    if (phraseEnv) {
      for (const raw of dfsItems<{
        phrase?: string
        date?: string
        citations_count?: number
      }>(phraseEnv)) {
        if (!raw.date || !raw.phrase) continue
        trends.push({
          date: raw.date.slice(0, 10),
          label: raw.phrase,
          value: raw.citations_count ?? null,
          kind: "phrase",
        })
      }
    }
    if (categoryEnv) {
      for (const raw of dfsItems<{
        category?: string
        date?: string
        citations_count?: number
      }>(categoryEnv)) {
        if (!raw.date || !raw.category) continue
        trends.push({
          date: raw.date.slice(0, 10),
          label: raw.category,
          value: raw.citations_count ?? null,
          kind: "category",
        })
      }
    }

    return {
      data: { citations, stats, trends },
      endpoints: [
        "/v3/content_analysis/search/live",
        "/v3/content_analysis/summary/live",
        "/v3/content_analysis/sentiment_analysis/live",
        "/v3/content_analysis/rating_distribution/live",
        ...(phraseEnv ? ["/v3/content_analysis/phrase_trends/live"] : []),
        ...(categoryEnv ? ["/v3/content_analysis/category_trends/live"] : []),
      ],
      costUsd: dfsCost(
        searchEnv,
        summaryEnv,
        sentimentEnv,
        ratingEnv,
        phraseEnv,
        categoryEnv,
      ),
    }
  })
}
