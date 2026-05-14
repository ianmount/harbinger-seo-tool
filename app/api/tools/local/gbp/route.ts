import { z } from "zod"
import { runTool } from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const Input = z.object({
  keyword: z.string().min(1),
  location_code: z.number().int().optional(),
  location_name: z.string().optional(),
  language_code: z.string().default("en"),
  limit: z.number().int().min(1).max(100).default(50),
})

type Row = {
  title: string
  category: string | null
  rating: number | null
  rating_count: number | null
  address: string | null
  phone: string | null
  url: string | null
}

export async function POST(request: Request) {
  return runTool<typeof Input, Row>(request, Input, async (input, { dfs }) => {
    const locFields = input.location_code
      ? { location_code: input.location_code, language_code: input.language_code }
      : {
          location_name: input.location_name ?? "United States",
          language_name: "English",
        }

    const body = [{ keyword: input.keyword, ...locFields, limit: input.limit }]
    const env = (await dfs(
      "/v3/business_data/google/my_business_info/live",
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
        title?: string
        category?: string | null
        rating?: { value?: number | null; votes_count?: number | null }
        address?: string | null
        phone?: string | null
        url?: string | null
      }
      return {
        title: it.title ?? "",
        category: it.category ?? null,
        rating: it.rating?.value ?? null,
        rating_count: it.rating?.votes_count ?? null,
        address: it.address ?? null,
        phone: it.phone ?? null,
        url: it.url ?? null,
      }
    })
    return {
      rows,
      endpoints: ["/v3/business_data/google/my_business_info/live"],
      costUsd: env.cost,
    }
  })
}
