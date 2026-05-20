import { z } from "zod"
import { dfsCost, dfsItems, runTool } from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const Input = z.object({
  target: z.string().min(3),
})

type SpamRating = {
  target: string
  spam_score: number | null
}

type Summary = {
  backlinks: number | null
  referring_domains: number | null
  rank: number | null
  referring_ips: number | null
  referring_subnets: number | null
  broken_backlinks: number | null
}

type DomainRow = {
  domain: string
  backlinks: number | null
  rank: number | null
  spam_score: number | null
  first_seen: string | null
  is_lost: boolean
}

type AnchorRow = {
  anchor: string
  backlinks: number | null
  referring_domains: number | null
  dofollow: number | null
  first_seen: string | null
}

type TimeseriesPoint = {
  date: string
  new_backlinks: number
  lost_backlinks: number
}

type NetworkRow = {
  network_address: string
  referring_domains: number | null
  backlinks: number | null
}

type Data = {
  spam: SpamRating
  summary: Summary
  domains: DomainRow[]
  anchors: AnchorRow[]
  timeseries: TimeseriesPoint[]
  networks: NetworkRow[]
}

// Twelve months back, day 1, for the timeseries window.
function twelveMonthsAgo(): string {
  const now = new Date()
  const d = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), 1))
  return d.toISOString().slice(0, 10)
}

export async function POST(request: Request) {
  return runTool<typeof Input, Data>(request, Input, async (input, { dfs }) => {
    const target = input.target

    const spamBody = [{ targets: [target] }]
    const summaryBody = [
      {
        target,
        internal_list_limit: 10,
        backlinks_status_type: "live",
      },
    ]
    const domainsBody = [
      {
        target,
        limit: 25,
        backlinks_status_type: "live",
        order_by: ["backlinks_spam_score,desc"],
      },
    ]
    const anchorsBody = [
      {
        target,
        limit: 25,
        backlinks_status_type: "live",
        order_by: ["backlinks,desc"],
      },
    ]
    const timeseriesBody = [
      {
        target,
        group_range: "month",
        date_from: twelveMonthsAgo(),
      },
    ]
    const networksBody = [
      {
        target,
        limit: 10,
        // "ip" is the proven value used by the Referring Domains tab. The
        // docs list "subnet" too, but it surfaces a 40501 "Invalid Field:
        // 'target'" — apparently incompatible with target-by-domain.
        network_address_type: "ip",
        backlinks_status_type: "live",
      },
    ]

    // Wrap each DFS call so a single endpoint failure surfaces *which*
    // endpoint failed — dfsRequest's error string only includes the DFS
    // status code/message, not the URL.
    async function labeled<T>(endpoint: string, p: Promise<T>): Promise<T> {
      try {
        return await p
      } catch (err) {
        if (err instanceof Error) {
          err.message = `${endpoint}: ${err.message}`
        }
        throw err
      }
    }

    const [
      spamEnv,
      summaryEnv,
      domainsEnv,
      anchorsEnv,
      timeseriesEnv,
      networksEnv,
    ] = await Promise.all([
      labeled(
        "bulk_spam_score",
        dfs("/v3/backlinks/bulk_spam_score/live", spamBody),
      ),
      labeled("summary", dfs("/v3/backlinks/summary/live", summaryBody)),
      labeled(
        "referring_domains",
        dfs("/v3/backlinks/referring_domains/live", domainsBody),
      ),
      labeled("anchors", dfs("/v3/backlinks/anchors/live", anchorsBody)),
      labeled(
        "timeseries_new_lost_summary",
        dfs("/v3/backlinks/timeseries_new_lost_summary/live", timeseriesBody),
      ),
      labeled(
        "referring_networks",
        dfs("/v3/backlinks/referring_networks/live", networksBody),
      ),
    ])

    const spamItems = dfsItems<{ target?: string; spam_score?: number | null }>(
      spamEnv,
    )
    const spam: SpamRating = {
      target,
      spam_score: spamItems[0]?.spam_score ?? null,
    }

    // summary/live nests one row per task directly under result, not under
    // items (.tasks[i].result[0] === the row). dfsItems would miss it.
    const summaryEnvShape = summaryEnv as {
      tasks?: {
        result?:
          | {
              backlinks?: number | null
              referring_domains?: number | null
              referring_main_domains?: number | null
              rank?: number | null
              referring_ips?: number | null
              referring_subnets?: number | null
              broken_backlinks?: number | null
            }[]
          | null
      }[]
    }
    const summaryRaw = summaryEnvShape.tasks?.[0]?.result?.[0] ?? {}
    const summary: Summary = {
      backlinks: summaryRaw.backlinks ?? null,
      referring_domains:
        summaryRaw.referring_main_domains ??
        summaryRaw.referring_domains ??
        null,
      rank: summaryRaw.rank ?? null,
      referring_ips: summaryRaw.referring_ips ?? null,
      referring_subnets: summaryRaw.referring_subnets ?? null,
      broken_backlinks: summaryRaw.broken_backlinks ?? null,
    }

    const domains: DomainRow[] = dfsItems<{
      domain?: string
      backlinks?: number | null
      rank?: number | null
      backlinks_spam_score?: number | null
      first_seen?: string | null
      is_lost?: boolean
      lost_date?: string | null
    }>(domainsEnv).map((it) => ({
      domain: it.domain ?? "",
      backlinks: it.backlinks ?? null,
      rank: it.rank ?? null,
      spam_score: it.backlinks_spam_score ?? null,
      first_seen: it.first_seen ?? null,
      is_lost: typeof it.is_lost === "boolean" ? it.is_lost : Boolean(it.lost_date),
    }))

    const anchors: AnchorRow[] = dfsItems<{
      anchor?: string
      backlinks?: number | null
      referring_domains?: number | null
      dofollow?: number | null
      first_seen?: string | null
    }>(anchorsEnv).map((it) => ({
      anchor: it.anchor ?? "",
      backlinks: it.backlinks ?? null,
      referring_domains: it.referring_domains ?? null,
      dofollow: it.dofollow ?? null,
      first_seen: it.first_seen ?? null,
    }))

    const timeseries: TimeseriesPoint[] = dfsItems<{
      date?: string
      new_backlinks?: number | null
      lost_backlinks?: number | null
    }>(timeseriesEnv)
      .filter((it): it is { date: string; new_backlinks?: number | null; lost_backlinks?: number | null } => Boolean(it.date))
      .map((it) => ({
        date: it.date.slice(0, 10),
        new_backlinks: it.new_backlinks ?? 0,
        lost_backlinks: it.lost_backlinks ?? 0,
      }))
      .sort((a, b) => a.date.localeCompare(b.date))

    const networks: NetworkRow[] = dfsItems<{
      network_address?: string
      referring_domains?: number | null
      backlinks?: number | null
    }>(networksEnv).map((it) => ({
      network_address: it.network_address ?? "",
      referring_domains: it.referring_domains ?? null,
      backlinks: it.backlinks ?? null,
    }))

    return {
      data: { spam, summary, domains, anchors, timeseries, networks },
      endpoints: [
        "/v3/backlinks/bulk_spam_score/live",
        "/v3/backlinks/summary/live",
        "/v3/backlinks/referring_domains/live",
        "/v3/backlinks/anchors/live",
        "/v3/backlinks/timeseries_new_lost_summary/live",
        "/v3/backlinks/referring_networks/live",
      ],
      costUsd: dfsCost(
        spamEnv,
        summaryEnv,
        domainsEnv,
        anchorsEnv,
        timeseriesEnv,
        networksEnv,
      ),
    }
  })
}
