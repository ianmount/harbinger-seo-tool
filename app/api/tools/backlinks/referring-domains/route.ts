import { z } from "zod"
import { runTool } from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const Input = z.object({
  target: z.string().min(3),
  limit: z.number().int().min(1).max(1000).default(200),
})

type Row = {
  domain: string
  rank: number | null
  backlinks: number | null
  first_seen: string | null
  lost_date: string | null
  dofollow: number | null
}

export async function POST(request: Request) {
  return runTool<typeof Input, Row>(request, Input, async (input, { dfs }) => {
    const body = [
      {
        target: input.target,
        limit: input.limit,
        backlinks_status_type: "live",
        order_by: ["rank,desc"],
      },
    ]
    const env = (await dfs("/v3/backlinks/referring_domains/live", body)) as {
      cost?: number
      tasks?: { result?: { items?: unknown[] }[] }[]
    }
    const items =
      env.tasks?.flatMap((t) => t.result?.flatMap((r) => r.items ?? []) ?? []) ??
      []
    const rows: Row[] = items.map((raw) => {
      const it = raw as {
        domain?: string
        rank?: number | null
        backlinks?: number | null
        first_seen?: string | null
        lost_date?: string | null
        dofollow?: number | null
      }
      return {
        domain: it.domain ?? "",
        rank: it.rank ?? null,
        backlinks: it.backlinks ?? null,
        first_seen: it.first_seen ?? null,
        lost_date: it.lost_date ?? null,
        dofollow: it.dofollow ?? null,
      }
    })
    return {
      rows,
      endpoints: ["/v3/backlinks/referring_domains/live"],
      costUsd: env.cost,
    }
  })
}
