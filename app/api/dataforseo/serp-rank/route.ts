import { NextResponse } from "next/server"
import { z } from "zod"
import { DataForSEOError, serpRankedDomains } from "@/lib/dataforseo"

export const dynamic = "force-dynamic"
// Per-keyword SERP probes are slow (~2-5s each from DFS). 200 keywords at
// concurrency 8 puts us comfortably under Vercel's default 60s, but bump
// the budget to be safe.
export const maxDuration = 300

/**
 * Batch endpoint that, for a given (domain, locationCode), probes
 * DataForSEO's live SERP for each input keyword and returns the domain's
 * absolute rank in the top-100 organic results. Keywords where the domain
 * doesn't appear get `position: null` (interpreted as "not ranked in
 * top 100" in the UI).
 *
 * The keyword research tab calls this once per location, after Claude has
 * already filtered the candidate pool down to its scored output, so the
 * caller controls cost via the `maxKeywords` knob upstream.
 */

const bodySchema = z.object({
  keywords: z.array(z.string().trim().min(1)).min(1).max(500),
  locationCode: z.number().int().positive(),
  domain: z.string().trim().min(1),
  // SERP depth — top-N to consider when looking up the domain. Default 100
  // matches the depth `serpRankedDomains` already uses; lower values are
  // cheaper but miss long-tail rankings.
  depth: z.number().int().positive().max(100).optional(),
})

// Cap parallel SERP requests so we don't hammer the DFS endpoint and risk
// 429s. Empirically 8 keeps p99 latency reasonable without rate-limiting.
const SERP_CONCURRENCY = 8

function normalizeDomain(input: string): string {
  let d = input.trim().toLowerCase()
  d = d.replace(/^https?:\/\//, "")
  d = d.replace(/^www\./, "")
  d = d.replace(/\/.*$/, "")
  return d
}

async function pMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++
      results[i] = await fn(items[i], i)
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  )
  await Promise.all(workers)
  return results
}

export async function POST(request: Request) {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON" },
      { status: 400 },
    )
  }
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request body", issues: parsed.error.flatten() },
      { status: 400 },
    )
  }
  const { keywords, locationCode, depth } = parsed.data
  const target = normalizeDomain(parsed.data.domain)
  if (!target) {
    return NextResponse.json(
      { error: "Domain could not be normalized" },
      { status: 400 },
    )
  }

  type RankRow = { keyword: string; position: number | null }
  try {
    const rows = await pMap<string, RankRow>(
      keywords,
      SERP_CONCURRENCY,
      async (keyword) => {
        try {
          const items = await serpRankedDomains(
            keyword,
            { code: locationCode },
            { depth: depth ?? 100 },
          )
          // serpRankedDomains already lowercases the domain; match exact
          // first, then a permissive suffix match for subdomains
          // (e.g. blog.example.com → example.com).
          const exact = items.find((it) => it.domain === target)
          if (exact) return { keyword, position: exact.rankAbsolute }
          const suffix = items.find(
            (it) => it.domain === target || it.domain.endsWith(`.${target}`),
          )
          return { keyword, position: suffix?.rankAbsolute ?? null }
        } catch (err) {
          // Don't let one failed SERP probe abort the whole batch — log it
          // and return null so the row renders as "not ranked".
          console.warn(
            `[api/dataforseo/serp-rank] probe failed for "${keyword}":`,
            err instanceof Error ? err.message : err,
          )
          return { keyword, position: null }
        }
      },
    )
    return NextResponse.json({ rows })
  } catch (error: unknown) {
    console.error("[api/dataforseo/serp-rank] failed:", error)
    if (error instanceof DataForSEOError) {
      const status = error.status ?? 502
      return NextResponse.json({ error: error.message }, { status })
    }
    const message = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
