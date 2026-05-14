import { z } from "zod"
import { dfsCost, runTool } from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const Input = z.object({ target: z.string().min(3) })

type TechRow = {
  category: string
  technology: string
  group: string | null
  first_detected: string | null
}

type WhoisRow = {
  field: string
  value: string
}

type Data = { technologies: TechRow[]; whois: WhoisRow[] }

export async function POST(request: Request) {
  return runTool<typeof Input, Data>(request, Input, async (input, { dfs }) => {
    const techBody = [{ target: input.target }]
    const whoisBody = [
      {
        filters: [["domain", "=", input.target]],
        limit: 1,
      },
    ]

    const [techEnv, whoisEnv] = await Promise.all([
      dfs(
        "/v3/domain_analytics/technologies/domain_technologies/live",
        techBody,
      ),
      dfs("/v3/domain_analytics/whois/overview/live", whoisBody),
    ])

    const technologies: TechRow[] = []
    const techTasks = (
      techEnv as {
        tasks?: {
          result?: {
            first_detected?: string
            technologies?: Record<string, Record<string, string[]>>
          }[]
        }[]
      }
    ).tasks
    for (const task of techTasks ?? []) {
      for (const r of task.result ?? []) {
        const first = r.first_detected ?? null
        for (const [category, groupMap] of Object.entries(r.technologies ?? {})) {
          for (const [group, items] of Object.entries(groupMap)) {
            for (const tech of items) {
              technologies.push({
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

    const whois: WhoisRow[] = []
    const whoisTasks = (
      whoisEnv as {
        tasks?: { result?: { items?: Record<string, unknown>[] }[] }[]
      }
    ).tasks
    const whoisItem = whoisTasks?.[0]?.result?.[0]?.items?.[0]
    if (whoisItem) {
      const interesting = [
        "domain",
        "created_datetime",
        "changed_datetime",
        "expiration_datetime",
        "registrar",
        "registrant_name",
        "registrant_organization",
        "registrant_country",
        "name_servers",
        "first_seen",
        "epp_status_codes",
        "tld",
        "url_redirect",
      ]
      for (const field of interesting) {
        const value = whoisItem[field]
        if (value == null) continue
        whois.push({
          field,
          value: Array.isArray(value) ? value.join(", ") : String(value),
        })
      }
    }

    return {
      data: { technologies, whois },
      endpoints: [
        "/v3/domain_analytics/technologies/domain_technologies/live",
        "/v3/domain_analytics/whois/overview/live",
      ],
      costUsd: dfsCost(techEnv, whoisEnv),
    }
  })
}
