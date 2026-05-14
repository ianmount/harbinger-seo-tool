import { z } from "zod"
import { dfsCost, dfsItems, runTool } from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const Input = z.object({
  target: z.string().min(3),
  limit: z.number().int().min(1).max(1000).default(200),
})

type DomainRow = {
  domain: string
  rank: number | null
  backlinks: number | null
  first_seen: string | null
  lost_date: string | null
  dofollow: number | null
}

type NetworkRow = {
  network: string
  network_type: string | null
  referring_domains: number | null
  backlinks: number | null
}

type Data = { domains: DomainRow[]; networks: NetworkRow[] }

export async function POST(request: Request) {
  return runTool<typeof Input, Data>(request, Input, async (input, { dfs }) => {
    const domainsBody = [
      {
        target: input.target,
        limit: input.limit,
        backlinks_status_type: "live",
        order_by: ["rank,desc"],
      },
    ]
    const networksBody = [
      {
        target: input.target,
        limit: input.limit,
        network_address_type: "ip",
        backlinks_status_type: "live",
      },
    ]

    const [domainsEnv, networksEnv] = await Promise.all([
      dfs("/v3/backlinks/referring_domains/live", domainsBody),
      dfs("/v3/backlinks/referring_networks/live", networksBody),
    ])

    const domains: DomainRow[] = dfsItems<{
      domain?: string
      rank?: number | null
      backlinks?: number | null
      first_seen?: string | null
      lost_date?: string | null
      dofollow?: number | null
    }>(domainsEnv).map((it) => ({
      domain: it.domain ?? "",
      rank: it.rank ?? null,
      backlinks: it.backlinks ?? null,
      first_seen: it.first_seen ?? null,
      lost_date: it.lost_date ?? null,
      dofollow: it.dofollow ?? null,
    }))

    const networks: NetworkRow[] = dfsItems<{
      network_address?: string
      network_address_type?: string | null
      referring_domains?: number | null
      backlinks?: number | null
    }>(networksEnv).map((it) => ({
      network: it.network_address ?? "",
      network_type: it.network_address_type ?? null,
      referring_domains: it.referring_domains ?? null,
      backlinks: it.backlinks ?? null,
    }))

    return {
      data: { domains, networks },
      endpoints: [
        "/v3/backlinks/referring_domains/live",
        "/v3/backlinks/referring_networks/live",
      ],
      costUsd: dfsCost(domainsEnv, networksEnv),
    }
  })
}
