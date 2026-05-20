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

/**
 * Per-section status. The dashboard renders 6 independent panels; one
 * endpoint's failure shouldn't blank out the whole page. Successful
 * sections carry `data`; failed sections carry `error`.
 */
type SectionResult<T> = { data: T; error: null } | { data: null; error: string }

type Data = {
  spam: SectionResult<SpamRating>
  summary: SectionResult<Summary>
  domains: SectionResult<DomainRow[]>
  anchors: SectionResult<AnchorRow[]>
  timeseries: SectionResult<TimeseriesPoint[]>
  networks: SectionResult<NetworkRow[]>
}

// Twelve months back, day 1, for the timeseries window.
function twelveMonthsAgo(): string {
  const now = new Date()
  const d = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), 1))
  return d.toISOString().slice(0, 10)
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Normalize user input to a bare host string (no scheme, no path, no
 * trailing slash, lowercased). Several DFS backlink endpoints — notably
 * timeseries_new_lost_summary/live — reject targets that include a path
 * with a cryptic 40501 "Invalid Field: 'target'".
 */
function toDomain(raw: string): string {
  const trimmed = raw.trim()
  const noProto = trimmed.replace(/^https?:\/\//i, "")
  const slashIdx = noProto.indexOf("/")
  const hostOnly = slashIdx === -1 ? noProto : noProto.slice(0, slashIdx)
  return hostOnly.toLowerCase()
}

export async function POST(request: Request) {
  return runTool<typeof Input, Data>(request, Input, async (input, { dfs }) => {
    const target = toDomain(input.target)

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
        date_to: todayIso(),
      },
    ]
    const networksBody = [
      {
        target,
        limit: 10,
        network_address_type: "ip",
        backlinks_status_type: "live",
      },
    ]

    // Run all six calls concurrently; a single endpoint's failure should
    // not blank out the whole dashboard. We collect per-section results
    // and surface failures inline.
    const settled = await Promise.allSettled([
      dfs("/v3/backlinks/bulk_spam_score/live", spamBody),
      dfs("/v3/backlinks/summary/live", summaryBody),
      dfs("/v3/backlinks/referring_domains/live", domainsBody),
      dfs("/v3/backlinks/anchors/live", anchorsBody),
      dfs("/v3/backlinks/timeseries_new_lost_summary/live", timeseriesBody),
      dfs("/v3/backlinks/referring_networks/live", networksBody),
    ])

    const [
      spamSettled,
      summarySettled,
      domainsSettled,
      anchorsSettled,
      timeseriesSettled,
      networksSettled,
    ] = settled

    function toErrorString(reason: unknown): string {
      if (reason instanceof Error) return reason.message
      return typeof reason === "string" ? reason : "Unknown error"
    }

    // ── spam ──────────────────────────────────────────────────────────
    let spam: SectionResult<SpamRating>
    if (spamSettled.status === "fulfilled") {
      const items = dfsItems<{ target?: string; spam_score?: number | null }>(
        spamSettled.value,
      )
      spam = {
        data: { target, spam_score: items[0]?.spam_score ?? null },
        error: null,
      }
    } else {
      spam = { data: null, error: toErrorString(spamSettled.reason) }
    }

    // ── summary ───────────────────────────────────────────────────────
    let summary: SectionResult<Summary>
    if (summarySettled.status === "fulfilled") {
      const env = summarySettled.value as {
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
      const raw = env.tasks?.[0]?.result?.[0] ?? {}
      summary = {
        data: {
          backlinks: raw.backlinks ?? null,
          referring_domains:
            raw.referring_main_domains ?? raw.referring_domains ?? null,
          rank: raw.rank ?? null,
          referring_ips: raw.referring_ips ?? null,
          referring_subnets: raw.referring_subnets ?? null,
          broken_backlinks: raw.broken_backlinks ?? null,
        },
        error: null,
      }
    } else {
      summary = { data: null, error: toErrorString(summarySettled.reason) }
    }

    // ── referring domains ─────────────────────────────────────────────
    let domains: SectionResult<DomainRow[]>
    if (domainsSettled.status === "fulfilled") {
      const rows: DomainRow[] = dfsItems<{
        domain?: string
        backlinks?: number | null
        rank?: number | null
        backlinks_spam_score?: number | null
        first_seen?: string | null
        is_lost?: boolean
        lost_date?: string | null
      }>(domainsSettled.value).map((it) => ({
        domain: it.domain ?? "",
        backlinks: it.backlinks ?? null,
        rank: it.rank ?? null,
        spam_score: it.backlinks_spam_score ?? null,
        first_seen: it.first_seen ?? null,
        is_lost:
          typeof it.is_lost === "boolean" ? it.is_lost : Boolean(it.lost_date),
      }))
      domains = { data: rows, error: null }
    } else {
      domains = { data: null, error: toErrorString(domainsSettled.reason) }
    }

    // ── anchors ───────────────────────────────────────────────────────
    let anchors: SectionResult<AnchorRow[]>
    if (anchorsSettled.status === "fulfilled") {
      const rows: AnchorRow[] = dfsItems<{
        anchor?: string
        backlinks?: number | null
        referring_domains?: number | null
        dofollow?: number | null
        first_seen?: string | null
      }>(anchorsSettled.value).map((it) => ({
        anchor: it.anchor ?? "",
        backlinks: it.backlinks ?? null,
        referring_domains: it.referring_domains ?? null,
        dofollow: it.dofollow ?? null,
        first_seen: it.first_seen ?? null,
      }))
      anchors = { data: rows, error: null }
    } else {
      anchors = { data: null, error: toErrorString(anchorsSettled.reason) }
    }

    // ── timeseries ────────────────────────────────────────────────────
    let timeseries: SectionResult<TimeseriesPoint[]>
    if (timeseriesSettled.status === "fulfilled") {
      const rows: TimeseriesPoint[] = dfsItems<{
        date?: string
        new_backlinks?: number | null
        lost_backlinks?: number | null
      }>(timeseriesSettled.value)
        .filter(
          (
            it,
          ): it is {
            date: string
            new_backlinks?: number | null
            lost_backlinks?: number | null
          } => Boolean(it.date),
        )
        .map((it) => ({
          date: it.date.slice(0, 10),
          new_backlinks: it.new_backlinks ?? 0,
          lost_backlinks: it.lost_backlinks ?? 0,
        }))
        .sort((a, b) => a.date.localeCompare(b.date))
      timeseries = { data: rows, error: null }
    } else {
      timeseries = {
        data: null,
        error: toErrorString(timeseriesSettled.reason),
      }
    }

    // ── referring networks ────────────────────────────────────────────
    let networks: SectionResult<NetworkRow[]>
    if (networksSettled.status === "fulfilled") {
      const rows: NetworkRow[] = dfsItems<{
        network_address?: string
        referring_domains?: number | null
        backlinks?: number | null
      }>(networksSettled.value).map((it) => ({
        network_address: it.network_address ?? "",
        referring_domains: it.referring_domains ?? null,
        backlinks: it.backlinks ?? null,
      }))
      networks = { data: rows, error: null }
    } else {
      networks = { data: null, error: toErrorString(networksSettled.reason) }
    }

    // Sum cost across only the fulfilled envelopes.
    const fulfilledEnvs: unknown[] = []
    for (const s of settled) {
      if (s.status === "fulfilled") fulfilledEnvs.push(s.value)
    }

    return {
      data: {
        spam,
        summary,
        domains,
        anchors,
        timeseries,
        networks,
      },
      endpoints: [
        "/v3/backlinks/bulk_spam_score/live",
        "/v3/backlinks/summary/live",
        "/v3/backlinks/referring_domains/live",
        "/v3/backlinks/anchors/live",
        "/v3/backlinks/timeseries_new_lost_summary/live",
        "/v3/backlinks/referring_networks/live",
      ],
      costUsd: dfsCost(...fulfilledEnvs),
    }
  })
}
