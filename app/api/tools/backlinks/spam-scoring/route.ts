import { z } from "zod"
import { dfsCost, dfsItems, runTool } from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const Input = z.object({
  targets: z.array(z.string().min(3)).min(1).max(1000),
})

type Row = { target: string; spam_score: number | null }
type Data = { rows: Row[] }

export async function POST(request: Request) {
  return runTool<typeof Input, Data>(request, Input, async (input, { dfs }) => {
    const env = await dfs("/v3/backlinks/bulk_spam_score/live", [
      { targets: input.targets },
    ])
    const rows: Row[] = dfsItems<{ target?: string; spam_score?: number | null }>(
      env,
    ).map((it) => ({
      target: it.target ?? "",
      spam_score: it.spam_score ?? null,
    }))
    return {
      data: { rows },
      endpoints: ["/v3/backlinks/bulk_spam_score/live"],
      costUsd: dfsCost(env),
    }
  })
}
