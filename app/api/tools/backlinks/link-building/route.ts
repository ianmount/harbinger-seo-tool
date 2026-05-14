import { z } from "zod"
import { runTool } from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const Input = z.object({
  target: z.string().min(3),
  limit: z.number().int().min(1).max(1000).default(100),
})

type Row = {
  domain: string
  rank: number | null
  backlinks: number | null
  first_seen: string | null
}

export async function POST(request: Request) {
  return runTool<typeof Input, Row>(request, Input, async (input, { dfs }) => {
    const body = [{ target: input.target, limit: input.limit }]
    const env = (await dfs("/v3/backlinks/competitors/live", body)) as {
      cost?: number
      tasks?: { result?: { items?: unknown[] }[] }[]
    }
    const items =
      env.tasks?.flatMap((t) => t.result?.flatMap((r) => r.items ?? []) ?? []) ??
      []
    const rows: Row[] = items.map((raw) => {
      const it = raw as {
        target?: string
        rank?: number | null
        backlinks?: number | null
        intersections?: number | null
        first_seen?: string | null
      }
      return {
        domain: it.target ?? "",
        rank: it.rank ?? null,
        backlinks: it.intersections ?? it.backlinks ?? null,
        first_seen: it.first_seen ?? null,
      }
    })
    return {
      rows,
      endpoints: ["/v3/backlinks/competitors/live"],
      costUsd: env.cost,
    }
  })
}
