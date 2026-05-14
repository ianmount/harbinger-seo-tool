import { z } from "zod"
import { runTool } from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const Input = z.object({ target: z.string().min(3) })

type Row = {
  category: string
  technology: string
  group: string | null
  first_detected: string | null
}

export async function POST(request: Request) {
  return runTool<typeof Input, Row>(request, Input, async (input, { dfs }) => {
    const body = [{ target: input.target }]
    const env = (await dfs(
      "/v3/domain_analytics/technologies/domain_technologies/live",
      body,
    )) as {
      cost?: number
      tasks?: {
        result?: {
          domain?: string
          first_detected?: string
          technologies?: Record<string, Record<string, string[]>>
        }[]
      }[]
    }

    const rows: Row[] = []
    for (const task of env.tasks ?? []) {
      for (const r of task.result ?? []) {
        const first = r.first_detected ?? null
        const techs = r.technologies ?? {}
        for (const [category, groupMap] of Object.entries(techs)) {
          for (const [group, items] of Object.entries(groupMap)) {
            for (const tech of items) {
              rows.push({
                category,
                technology: tech,
                group,
                first_detected: first,
              })
            }
          }
        }
      }
    }
    return {
      rows,
      endpoints: ["/v3/domain_analytics/technologies/domain_technologies/live"],
      costUsd: env.cost,
    }
  })
}
