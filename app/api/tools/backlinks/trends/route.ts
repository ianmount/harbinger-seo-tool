import { z } from "zod"
import { runTool } from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const Input = z.object({
  target: z.string().min(3),
  group_range: z.enum(["day", "week", "month", "year"]).default("month"),
})

type Row = {
  date: string
  backlinks: number | null
  referring_domains: number | null
  new_backlinks: number | null
  lost_backlinks: number | null
}

export async function POST(request: Request) {
  return runTool<typeof Input, Row>(request, Input, async (input, { dfs }) => {
    const body = [
      {
        target: input.target,
        group_range: input.group_range,
        date_from: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10),
      },
    ]
    const env = (await dfs(
      "/v3/backlinks/timeseries_summary/live",
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
        date?: string
        summary?: {
          backlinks?: number | null
          referring_domains?: number | null
          new_backlinks?: number | null
          lost_backlinks?: number | null
        }
        backlinks?: number | null
        referring_domains?: number | null
        new_backlinks?: number | null
        lost_backlinks?: number | null
      }
      return {
        date: (it.date ?? "").slice(0, 10),
        backlinks: it.summary?.backlinks ?? it.backlinks ?? null,
        referring_domains:
          it.summary?.referring_domains ?? it.referring_domains ?? null,
        new_backlinks: it.summary?.new_backlinks ?? it.new_backlinks ?? null,
        lost_backlinks: it.summary?.lost_backlinks ?? it.lost_backlinks ?? null,
      }
    })
    return {
      rows,
      endpoints: ["/v3/backlinks/timeseries_summary/live"],
      costUsd: env.cost,
    }
  })
}
