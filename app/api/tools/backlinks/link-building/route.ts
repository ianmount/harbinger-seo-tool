import { z } from "zod"
import { dfsCost, dfsItems, runTool } from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 90

const Input = z.object({
  target: z.string().min(3),
  competitors: z.array(z.string().min(3)).max(5).default([]),
  pages: z.array(z.string().min(3)).max(5).default([]),
  limit: z.number().int().min(1).max(1000).default(200),
})

type CompetitorRow = {
  domain: string
  rank: number | null
  backlinks: number | null
  shared_backlinks: number | null
  first_seen: string | null
}

type IntersectionRow = {
  domain: string
  rank: number | null
  intersection_targets: string
}

type PageIntersectionRow = {
  url_from: string
  anchor: string | null
  rank: number | null
  intersection_targets: string
}

type Data = {
  competitors: CompetitorRow[]
  domainIntersection: IntersectionRow[]
  pageIntersection: PageIntersectionRow[]
}

export async function POST(request: Request) {
  return runTool<typeof Input, Data>(request, Input, async (input, { dfs }) => {
    const competitorsBody = [{ target: input.target, limit: input.limit }]

    // domain_intersection requires the `targets` keyed map of at least 2
    // domains (target + ≥1 competitor) — skip cleanly when none provided.
    const intersectionTargets =
      input.competitors.length > 0
        ? Object.fromEntries(
            [input.target, ...input.competitors].map((t, i) => [
              String(i + 1),
              t,
            ]),
          )
        : null

    const domainIntersectionBody = intersectionTargets
      ? [{ targets: intersectionTargets, limit: input.limit }]
      : null

    const pageIntersectionTargets =
      input.pages.length >= 2
        ? Object.fromEntries(
            input.pages.map((p, i) => [String(i + 1), p]),
          )
        : null

    const pageIntersectionBody = pageIntersectionTargets
      ? [{ targets: pageIntersectionTargets, limit: input.limit }]
      : null

    const [competitorsEnv, domainIntEnv, pageIntEnv] = await Promise.all([
      dfs("/v3/backlinks/competitors/live", competitorsBody),
      domainIntersectionBody
        ? dfs(
            "/v3/backlinks/domain_intersection/live",
            domainIntersectionBody,
          )
        : Promise.resolve(null),
      pageIntersectionBody
        ? dfs("/v3/backlinks/page_intersection/live", pageIntersectionBody)
        : Promise.resolve(null),
    ])

    const competitors: CompetitorRow[] = dfsItems<{
      target?: string
      rank?: number | null
      backlinks?: number | null
      intersections?: number | null
      first_seen?: string | null
    }>(competitorsEnv).map((it) => ({
      domain: it.target ?? "",
      rank: it.rank ?? null,
      backlinks: it.backlinks ?? null,
      shared_backlinks: it.intersections ?? null,
      first_seen: it.first_seen ?? null,
    }))

    const targetsLabel = (intersections: Record<string, unknown> | undefined) =>
      intersections
        ? Object.entries(intersections)
            .filter(([, v]) => Boolean(v))
            .map(([k]) => k)
            .join(", ")
        : ""

    const domainIntersection: IntersectionRow[] = domainIntEnv
      ? dfsItems<{
          domain?: string
          rank?: number | null
          intersections?: Record<string, unknown>
        }>(domainIntEnv).map((it) => ({
          domain: it.domain ?? "",
          rank: it.rank ?? null,
          intersection_targets: targetsLabel(it.intersections),
        }))
      : []

    const pageIntersection: PageIntersectionRow[] = pageIntEnv
      ? dfsItems<{
          url_from?: string
          anchor?: string | null
          rank?: number | null
          intersections?: Record<string, unknown>
        }>(pageIntEnv).map((it) => ({
          url_from: it.url_from ?? "",
          anchor: it.anchor ?? null,
          rank: it.rank ?? null,
          intersection_targets: targetsLabel(it.intersections),
        }))
      : []

    return {
      data: { competitors, domainIntersection, pageIntersection },
      endpoints: [
        "/v3/backlinks/competitors/live",
        ...(domainIntEnv ? ["/v3/backlinks/domain_intersection/live"] : []),
        ...(pageIntEnv ? ["/v3/backlinks/page_intersection/live"] : []),
      ],
      costUsd: dfsCost(competitorsEnv, domainIntEnv, pageIntEnv),
    }
  })
}
