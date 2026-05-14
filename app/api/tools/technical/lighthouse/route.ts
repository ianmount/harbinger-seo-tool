import { z } from "zod"
import { dfsCost, runTool } from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const Input = z.object({
  url: z.string().url(),
  for_mobile: z.boolean().default(true),
})

type Row = {
  category: string
  score: number | null
  display_value: string | null
}

type Data = { rows: Row[] }

// `task_post` is the async equivalent of `live/json` — same audit, just
// queued. We only call live/json since the rest of the tool surface
// expects a synchronous response. Spec endpoint footer lists both.

export async function POST(request: Request) {
  return runTool<typeof Input, Data>(request, Input, async (input, { dfs }) => {
    const body = [{ url: input.url, for_mobile: input.for_mobile }]
    const env = (await dfs("/v3/on_page/lighthouse/live/json", body, {
      timeoutMs: 180_000,
    })) as {
      cost?: number
      tasks?: {
        result?: {
          categories?: Record<
            string,
            { id?: string; title?: string; score?: number | null }
          >
          audits?: Record<
            string,
            {
              id?: string
              title?: string
              score?: number | null
              displayValue?: string | null
            }
          >
        }[]
      }[]
    }
    const rows: Row[] = []
    for (const task of env.tasks ?? []) {
      for (const r of task.result ?? []) {
        for (const cat of Object.values(r.categories ?? {})) {
          rows.push({
            category: cat.title ?? cat.id ?? "category",
            score: typeof cat.score === "number" ? cat.score : null,
            display_value: null,
          })
        }
        const cwvIds = [
          "largest-contentful-paint",
          "first-contentful-paint",
          "total-blocking-time",
          "cumulative-layout-shift",
          "speed-index",
          "interactive",
        ]
        for (const id of cwvIds) {
          const a = r.audits?.[id]
          if (!a) continue
          rows.push({
            category: a.title ?? id,
            score: typeof a.score === "number" ? a.score : null,
            display_value: a.displayValue ?? null,
          })
        }
      }
    }
    return {
      data: { rows },
      endpoints: ["/v3/on_page/lighthouse/live/json"],
      costUsd: dfsCost(env),
    }
  })
}
