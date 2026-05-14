import { z } from "zod"
import { dfsCost, dfsItems, locationFields, runTool } from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 90

const Input = z.object({
  target: z.string().min(3),
  location_code: z.number().int().optional(),
  location_name: z.string().optional(),
  language_code: z.string().default("en"),
  limit: z.number().int().min(1).max(100).default(50),
})

type SnapshotRow = {
  group: string
  metric: string
  value: number | string | null
}

type CompetitorRow = {
  domain: string
  rank: number | null
  organic_keywords: number | null
  organic_traffic: number | null
  organic_cost: number | null
  overlap_with_target: number | null
}

type SerpRow = {
  position: number
  domain: string
  url: string
  title: string | null
}

type Data = {
  snapshot: SnapshotRow[]
  competitors: CompetitorRow[]
  brandSerp: SerpRow[]
}

function pushNumbers(
  rows: SnapshotRow[],
  group: string,
  source: Record<string, unknown> | undefined,
  prefix = "",
) {
  if (!source) return
  for (const [k, v] of Object.entries(source)) {
    if (typeof v === "number" || typeof v === "string") {
      rows.push({ group, metric: `${prefix}${k}`, value: v })
    }
  }
}

export async function POST(request: Request) {
  return runTool<typeof Input, Data>(request, Input, async (input, { dfs }) => {
    const loc = locationFields(input)

    const overviewBody = [{ target: input.target, ...loc }]
    const summaryBody = [{ target: input.target }]
    const competitorsBody = [
      { target: input.target, ...loc, limit: input.limit },
    ]
    const serpBody = [
      { keyword: input.target, ...loc, depth: 10 },
    ]

    const [overviewEnv, summaryEnv, competitorsEnv, serpEnv] =
      await Promise.all([
        dfs(
          "/v3/dataforseo_labs/google/domain_rank_overview/live",
          overviewBody,
        ),
        dfs("/v3/backlinks/summary/live", summaryBody),
        dfs(
          "/v3/dataforseo_labs/google/competitors_domain/live",
          competitorsBody,
        ),
        dfs("/v3/serp/google/organic/live/advanced", serpBody, {
          timeoutMs: 90_000,
        }).catch(() => null),
      ])

    const snapshot: SnapshotRow[] = []
    for (const item of dfsItems<Record<string, unknown>>(overviewEnv)) {
      const metrics = item.metrics as
        | { organic?: Record<string, unknown>; paid?: Record<string, unknown> }
        | undefined
      pushNumbers(snapshot, "Organic", metrics?.organic, "organic.")
      pushNumbers(snapshot, "Paid", metrics?.paid, "paid.")
    }
    for (const task of (
      summaryEnv as { tasks?: { result?: Record<string, unknown>[] }[] }
    ).tasks ?? []) {
      for (const r of task.result ?? []) {
        for (const [k, v] of Object.entries(r)) {
          if (typeof v === "number") {
            snapshot.push({ group: "Backlinks", metric: k, value: v })
          }
        }
      }
    }

    const competitors: CompetitorRow[] = dfsItems<{
      domain?: string
      avg_position?: number | null
      metrics?: {
        organic?: {
          count?: number
          etv?: number
          estimated_paid_traffic_cost?: number
        }
      }
      intersections?: number | null
    }>(competitorsEnv).map((it) => ({
      domain: it.domain ?? "",
      rank: it.avg_position ?? null,
      organic_keywords: it.metrics?.organic?.count ?? null,
      organic_traffic: it.metrics?.organic?.etv ?? null,
      organic_cost: it.metrics?.organic?.estimated_paid_traffic_cost ?? null,
      overlap_with_target: it.intersections ?? null,
    }))

    const brandSerp: SerpRow[] = []
    if (serpEnv) {
      const env = serpEnv as {
        tasks?: {
          result?: {
            items?: {
              type?: string
              rank_absolute?: number
              domain?: string
              url?: string
              title?: string
            }[]
          }[]
        }[]
      }
      for (const task of env.tasks ?? []) {
        for (const r of task.result ?? []) {
          for (const it of r.items ?? []) {
            if (it.type !== "organic") continue
            if (!it.domain || !it.url) continue
            brandSerp.push({
              position: it.rank_absolute ?? 0,
              domain: it.domain,
              url: it.url,
              title: it.title ?? null,
            })
          }
        }
      }
    }

    return {
      data: { snapshot, competitors, brandSerp },
      endpoints: [
        "/v3/dataforseo_labs/google/domain_rank_overview/live",
        "/v3/backlinks/summary/live",
        "/v3/dataforseo_labs/google/competitors_domain/live",
        ...(serpEnv ? ["/v3/serp/google/organic/live/advanced"] : []),
      ],
      costUsd: dfsCost(overviewEnv, summaryEnv, competitorsEnv, serpEnv),
    }
  })
}
