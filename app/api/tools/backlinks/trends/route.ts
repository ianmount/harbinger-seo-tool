import { z } from "zod"
import { dfsCost, dfsItems, runTool } from "@/lib/tool-route"

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
  new_referring_domains: number | null
  lost_referring_domains: number | null
}

type Data = { rows: Row[] }

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000

export async function POST(request: Request) {
  return runTool<typeof Input, Data>(request, Input, async (input, { dfs }) => {
    const dateFrom = new Date(Date.now() - ONE_YEAR_MS)
      .toISOString()
      .slice(0, 10)

    const summaryBody = [
      {
        target: input.target,
        group_range: input.group_range,
        date_from: dateFrom,
      },
    ]
    const newLostBody = [
      {
        target: input.target,
        group_range: input.group_range,
        date_from: dateFrom,
      },
    ]
    const historyBody = [{ target: input.target, date_from: dateFrom }]

    const [summaryEnv, newLostEnv, historyEnv] = await Promise.all([
      dfs("/v3/backlinks/timeseries_summary/live", summaryBody),
      dfs("/v3/backlinks/timeseries_new_lost_summary/live", newLostBody),
      dfs("/v3/backlinks/history/live", historyBody),
    ])

    const byDate = new Map<string, Row>()
    const ensure = (date: string): Row => {
      const key = date.slice(0, 10)
      let row = byDate.get(key)
      if (!row) {
        row = {
          date: key,
          backlinks: null,
          referring_domains: null,
          new_backlinks: null,
          lost_backlinks: null,
          new_referring_domains: null,
          lost_referring_domains: null,
        }
        byDate.set(key, row)
      }
      return row
    }

    for (const raw of dfsItems<{
      date?: string
      backlinks?: number | null
      referring_domains?: number | null
    }>(summaryEnv)) {
      if (!raw.date) continue
      const row = ensure(raw.date)
      row.backlinks = raw.backlinks ?? row.backlinks
      row.referring_domains = raw.referring_domains ?? row.referring_domains
    }
    for (const raw of dfsItems<{
      date?: string
      new_backlinks?: number | null
      lost_backlinks?: number | null
      new_referring_domains?: number | null
      lost_referring_domains?: number | null
    }>(newLostEnv)) {
      if (!raw.date) continue
      const row = ensure(raw.date)
      row.new_backlinks = raw.new_backlinks ?? row.new_backlinks
      row.lost_backlinks = raw.lost_backlinks ?? row.lost_backlinks
      row.new_referring_domains =
        raw.new_referring_domains ?? row.new_referring_domains
      row.lost_referring_domains =
        raw.lost_referring_domains ?? row.lost_referring_domains
    }
    for (const raw of dfsItems<{
      date?: string
      backlinks?: number | null
      referring_domains?: number | null
    }>(historyEnv)) {
      if (!raw.date) continue
      const row = ensure(raw.date)
      // history is a point-in-time snapshot; only fill blanks rather than
      // overwriting timeseries_summary which is the canonical aggregate.
      if (row.backlinks == null) row.backlinks = raw.backlinks ?? null
      if (row.referring_domains == null)
        row.referring_domains = raw.referring_domains ?? null
    }

    const rows = Array.from(byDate.values()).sort((a, b) =>
      a.date.localeCompare(b.date),
    )

    return {
      data: { rows },
      endpoints: [
        "/v3/backlinks/history/live",
        "/v3/backlinks/timeseries_summary/live",
        "/v3/backlinks/timeseries_new_lost_summary/live",
      ],
      costUsd: dfsCost(summaryEnv, newLostEnv, historyEnv),
    }
  })
}
