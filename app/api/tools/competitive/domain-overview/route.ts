import { z } from "zod"
import { runTool } from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const Input = z.object({
  target: z.string().min(3),
  location_code: z.number().int().optional(),
  location_name: z.string().optional(),
  language_code: z.string().default("en"),
  limit: z.number().int().min(1).max(100).default(20),
})

type Row = {
  domain: string
  rank: number | null
  organic_keywords: number | null
  organic_traffic: number | null
  organic_cost: number | null
  overlap_with_target: number | null
}

export async function POST(request: Request) {
  return runTool<typeof Input, Row>(request, Input, async (input, { dfs }) => {
    const locFields = input.location_code
      ? { location_code: input.location_code, language_code: input.language_code }
      : {
          location_name: input.location_name ?? "United States",
          language_name: "English",
        }

    const body = [
      { target: input.target, ...locFields, limit: input.limit },
    ]
    const env = (await dfs(
      "/v3/dataforseo_labs/google/competitors_domain/live",
      body,
    )) as {
      cost?: number
      tasks?: { result?: { items?: unknown[] }[] }[]
    }
    const items =
      env.tasks?.flatMap((t) => t.result?.flatMap((r) => r.items ?? []) ?? []) ??
      []
    const rows: Row[] = items.map((raw) => {
      const it = raw as {
        domain?: string
        avg_position?: number | null
        metrics?: {
          organic?: {
            pos_1?: number
            pos_2_3?: number
            count?: number
            etv?: number
            estimated_paid_traffic_cost?: number
          }
        }
        intersections?: number | null
        full_domain_metrics?: { organic?: { count?: number } }
      }
      return {
        domain: it.domain ?? "",
        rank: it.avg_position ?? null,
        organic_keywords:
          it.metrics?.organic?.count ??
          it.full_domain_metrics?.organic?.count ??
          null,
        organic_traffic: it.metrics?.organic?.etv ?? null,
        organic_cost: it.metrics?.organic?.estimated_paid_traffic_cost ?? null,
        overlap_with_target: it.intersections ?? null,
      }
    })
    return {
      rows,
      endpoints: ["/v3/dataforseo_labs/google/competitors_domain/live"],
      costUsd: env.cost,
    }
  })
}
