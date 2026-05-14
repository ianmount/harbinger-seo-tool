import { z } from "zod"
import { dfsCost, dfsItems, runTool } from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const Input = z.object({
  target: z.string().min(3),
  limit: z.number().int().min(1).max(1000).default(200),
  mode: z.enum(["as_is", "one_per_domain", "one_per_anchor"]).default("as_is"),
})

type BacklinkRow = {
  url_from: string
  url_to: string
  anchor: string | null
  page_from_rank: number | null
  domain_from_rank: number | null
  dofollow: boolean
  first_seen: string | null
  last_seen: string | null
}

type AnchorRow = {
  anchor: string
  backlinks: number | null
  referring_domains: number | null
  first_seen: string | null
}

type Data = { backlinks: BacklinkRow[]; anchors: AnchorRow[] }

export async function POST(request: Request) {
  return runTool<typeof Input, Data>(request, Input, async (input, { dfs }) => {
    const backlinksBody = [
      {
        target: input.target,
        mode: input.mode,
        limit: input.limit,
        backlinks_status_type: "live",
      },
    ]
    const anchorsBody = [
      {
        target: input.target,
        limit: input.limit,
        backlinks_status_type: "live",
      },
    ]

    const [backlinksEnv, anchorsEnv] = await Promise.all([
      dfs("/v3/backlinks/backlinks/live", backlinksBody),
      dfs("/v3/backlinks/anchors/live", anchorsBody),
    ])

    const backlinks: BacklinkRow[] = dfsItems<{
      url_from?: string
      url_to?: string
      anchor?: string | null
      page_from_rank?: number | null
      domain_from_rank?: number | null
      dofollow?: boolean
      first_seen?: string | null
      last_seen?: string | null
    }>(backlinksEnv).map((it) => ({
      url_from: it.url_from ?? "",
      url_to: it.url_to ?? "",
      anchor: it.anchor ?? null,
      page_from_rank: it.page_from_rank ?? null,
      domain_from_rank: it.domain_from_rank ?? null,
      dofollow: Boolean(it.dofollow),
      first_seen: it.first_seen ?? null,
      last_seen: it.last_seen ?? null,
    }))

    const anchors: AnchorRow[] = dfsItems<{
      anchor?: string
      backlinks?: number | null
      referring_domains?: number | null
      first_seen?: string | null
    }>(anchorsEnv).map((it) => ({
      anchor: it.anchor ?? "",
      backlinks: it.backlinks ?? null,
      referring_domains: it.referring_domains ?? null,
      first_seen: it.first_seen ?? null,
    }))

    return {
      data: { backlinks, anchors },
      endpoints: [
        "/v3/backlinks/backlinks/live",
        "/v3/backlinks/anchors/live",
      ],
      costUsd: dfsCost(backlinksEnv, anchorsEnv),
    }
  })
}
