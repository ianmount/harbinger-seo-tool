import { z } from "zod"
import { runTool } from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const Input = z.object({
  targets: z.array(z.string().min(3)).min(1).max(1000),
})

type Row = { target: string; spam_score: number | null }

export async function POST(request: Request) {
  return runTool<typeof Input, Row>(request, Input, async (input, { dfs }) => {
    const body = [{ targets: input.targets }]
    const env = (await dfs("/v3/backlinks/bulk_spam_score/live", body)) as {
      cost?: number
      tasks?: { result?: { items?: unknown[] }[] }[]
    }
    const items =
      env.tasks?.flatMap((t) => t.result?.flatMap((r) => r.items ?? []) ?? []) ??
      []
    const rows: Row[] = items.map((raw) => {
      const it = raw as { target?: string; spam_score?: number | null }
      return {
        target: it.target ?? "",
        spam_score: it.spam_score ?? null,
      }
    })
    return {
      rows,
      endpoints: ["/v3/backlinks/bulk_spam_score/live"],
      costUsd: env.cost,
    }
  })
}
