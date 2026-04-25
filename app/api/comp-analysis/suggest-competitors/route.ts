import { NextResponse } from "next/server"
import { z } from "zod"
import { DataForSEOError, serpCompetitors } from "@/lib/dataforseo"

/**
 * Auto-suggest competitor domains for the Comp Analysis tab.
 *
 * Inputs: seed keywords (one per line) + target locations. For each
 * (seed × location) we call DataForSEO's organic SERP endpoint at depth 20,
 * collect every result domain, exclude the partner's own domain and the
 * standard non-competitor list (yelp.com, angi.com, etc.), tally domain
 * frequency across all queries, and return the top 6 by recurrence.
 *
 * Stateless. Uses DataForSEO only.
 */
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 120

const targetLocationSchema = z.object({
  city: z.string().min(1),
  state: z.string().min(1),
})

const bodySchema = z.object({
  partnerUrl: z.string().min(3),
  seedKeywords: z.array(z.string().min(1)).min(1).max(20),
  targetLocations: z.array(targetLocationSchema).min(1).max(10),
})

const NON_COMPETITOR_DOMAINS = new Set([
  "yelp.com",
  "angi.com",
  "homeadvisor.com",
  "bbb.org",
  "facebook.com",
  "yellowpages.com",
  "thumbtack.com",
  "nextdoor.com",
  "google.com",
  "wikipedia.org",
  "youtube.com",
  "instagram.com",
  "linkedin.com",
  "reddit.com",
  "pinterest.com",
  "tripadvisor.com",
  "indeed.com",
  "houzz.com",
  "porch.com",
  "manta.com",
])

function cleanDomain(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/.*$/, "")
    .toLowerCase()
}

function locationName(state: string): string {
  return `${state.trim()},United States`
}

async function mapWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results: U[] = new Array(items.length)
  let next = 0
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const i = next++
        if (i >= items.length) return
        results[i] = await fn(items[i], i)
      }
    },
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
  const { partnerUrl, seedKeywords, targetLocations } = parsed.data
  const partnerDomain = cleanDomain(partnerUrl)

  // Cap inputs so a careless user doesn't fan out to hundreds of calls.
  const seeds = seedKeywords.slice(0, 10)
  const states = Array.from(
    new Set(targetLocations.map((l) => l.state.trim().toLowerCase())),
  )
    .map((stateLower) => {
      const orig = targetLocations.find(
        (l) => l.state.trim().toLowerCase() === stateLower,
      )
      return orig ? orig.state.trim() : stateLower
    })
    .slice(0, 5)

  const tasks = seeds.flatMap((seed) =>
    states.map((state) => ({ seed, state })),
  )

  try {
    const results = await mapWithConcurrency(tasks, 5, async (t) => {
      try {
        return await serpCompetitors(
          t.seed,
          { name: locationName(t.state) },
          { depth: 20 },
        )
      } catch (err) {
        console.warn(
          `[api/comp-analysis/suggest] serpCompetitors failed for "${t.seed}" / ${t.state}:`,
          err,
        )
        return []
      }
    })

    const tally = new Map<string, number>()
    for (const domains of results) {
      for (const raw of domains) {
        const d = cleanDomain(raw)
        if (!d) continue
        if (d === partnerDomain) continue
        if (NON_COMPETITOR_DOMAINS.has(d)) continue
        tally.set(d, (tally.get(d) ?? 0) + 1)
      }
    }

    const ranked = [...tally.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([domain, frequency]) => ({ domain, frequency }))

    return NextResponse.json({ suggestions: ranked })
  } catch (error) {
    console.error("[api/comp-analysis/suggest] failed:", error)
    const status = error instanceof DataForSEOError ? 502 : 500
    const message = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json({ error: message }, { status })
  }
}
