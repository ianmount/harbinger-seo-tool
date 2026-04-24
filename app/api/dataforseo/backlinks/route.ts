import { NextResponse } from "next/server"
import { z } from "zod"
import { DataForSEOError, referringDomains } from "@/lib/dataforseo"
import type { ReferringDomain } from "@/lib/types"

export const dynamic = "force-dynamic"

// Domain-quality thresholds for backlink prospect selection:
//   - spamScore > SPAM_CEILING: drop (likely PBNs, spun-content farms).
//   - rank < RANK_FLOOR: drop (thin / low-authority sites not worth outreach).
// DataForSEO's `rank` is 0–1000 (higher = stronger); `spamScore` is 0–100.
const SPAM_CEILING = 30
const RANK_FLOOR = 10

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 1000
const MAX_COMPETITORS = 10

const bodySchema = z.object({
  competitors: z
    .array(z.string().trim().min(1))
    .min(1)
    .max(MAX_COMPETITORS),
  limit: z.number().int().positive().max(MAX_LIMIT).optional(),
})

/**
 * Strip scheme / path so DataForSEO sees a canonical host. Helpful when the
 * user pastes full URLs but the referring_domains endpoint is happier with
 * bare hostnames.
 */
function normalizeTarget(input: string): string {
  const trimmed = input.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "")
  return trimmed.toLowerCase()
}

function dedupeByDomain(rows: ReferringDomain[]): ReferringDomain[] {
  const seen = new Map<string, ReferringDomain>()
  for (const row of rows) {
    const key = row.domain.toLowerCase()
    const existing = seen.get(key)
    if (!existing) {
      seen.set(key, row)
      continue
    }
    // If the same referring domain appears across multiple competitors, keep
    // the highest-rank sighting. Preserve the `referringTo` that produced the
    // strongest signal so the user clicks through to a real example.
    if (row.rank > existing.rank) seen.set(key, row)
  }
  return Array.from(seen.values())
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

  const limit = parsed.data.limit ?? DEFAULT_LIMIT
  const targets = parsed.data.competitors.map(normalizeTarget).filter(Boolean)
  if (targets.length === 0) {
    return NextResponse.json(
      { error: "No valid competitor domains after normalization" },
      { status: 400 },
    )
  }

  try {
    // Fan out in parallel. Use allSettled so one bad target doesn't tank the
    // whole run — most users will paste 3–5 competitors and we'd rather hand
    // back partial results with a warning than fail everything.
    const settled = await Promise.allSettled(
      targets.map((t) => referringDomains(t, limit)),
    )
    const combined: ReferringDomain[] = []
    const failures: Array<{ target: string; error: string }> = []
    settled.forEach((result, i) => {
      if (result.status === "fulfilled") {
        combined.push(...result.value)
      } else {
        const err = result.reason
        failures.push({
          target: targets[i],
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })

    if (combined.length === 0) {
      const firstError = failures[0]?.error ?? "no referring domains returned"
      return NextResponse.json(
        {
          error: `No referring domains returned for any competitor. First error: ${firstError}`,
          failures,
        },
        { status: 502 },
      )
    }

    const deduped = dedupeByDomain(combined)
    const filtered = deduped.filter(
      (d) => d.spamScore <= SPAM_CEILING && d.rank >= RANK_FLOOR,
    )
    // Sort by rank desc so the strongest prospects are first in the table.
    filtered.sort((a, b) => b.rank - a.rank)

    return NextResponse.json({
      prospects: filtered,
      stats: {
        totalFetched: combined.length,
        deduped: deduped.length,
        afterFilter: filtered.length,
        spamCeiling: SPAM_CEILING,
        rankFloor: RANK_FLOOR,
      },
      failures,
    })
  } catch (error: unknown) {
    console.error("[api/dataforseo/backlinks] failed:", error)
    if (error instanceof DataForSEOError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status ?? 502 },
      )
    }
    const message = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
