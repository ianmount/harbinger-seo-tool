import { z } from "zod"
import { runTool } from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const Input = z.object({
  target: z.string().min(3),
  limit: z.number().int().min(1).max(1000).default(200),
  mode: z.enum(["as_is", "one_per_domain", "one_per_anchor"]).default("as_is"),
})

type Row = {
  url_from: string
  url_to: string
  anchor: string | null
  page_from_rank: number | null
  domain_from_rank: number | null
  dofollow: boolean
  first_seen: string | null
  last_seen: string | null
}

export async function POST(request: Request) {
  return runTool<typeof Input, Row>(request, Input, async (input, { dfs }) => {
    const body = [
      {
        target: input.target,
        mode: input.mode,
        limit: input.limit,
        backlinks_status_type: "live",
      },
    ]
    const env = (await dfs("/v3/backlinks/backlinks/live", body)) as {
      cost?: number
      tasks?: { result?: { items?: unknown[] }[] }[]
    }
    const items =
      env.tasks?.flatMap((t) => t.result?.flatMap((r) => r.items ?? []) ?? []) ??
      []
    const rows: Row[] = items.map((raw) => {
      const it = raw as {
        url_from?: string
        url_to?: string
        anchor?: string | null
        page_from_rank?: number | null
        domain_from_rank?: number | null
        dofollow?: boolean
        first_seen?: string | null
        last_seen?: string | null
      }
      return {
        url_from: it.url_from ?? "",
        url_to: it.url_to ?? "",
        anchor: it.anchor ?? null,
        page_from_rank: it.page_from_rank ?? null,
        domain_from_rank: it.domain_from_rank ?? null,
        dofollow: Boolean(it.dofollow),
        first_seen: it.first_seen ?? null,
        last_seen: it.last_seen ?? null,
      }
    })
    return {
      rows,
      endpoints: ["/v3/backlinks/backlinks/live"],
      costUsd: env.cost,
    }
  })
}
