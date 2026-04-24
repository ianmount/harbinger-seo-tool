import { NextResponse } from "next/server"
import { DataForSEOError, listLabsLocations } from "@/lib/dataforseo"
import type { DfsLabsLocation } from "@/lib/types"

export const dynamic = "force-dynamic"

const MAX_RESULTS = 50
const DEFAULT_COUNTRY = "US"

// Ranking: exact name match > starts-with > contains. Within each tier,
// prefer more specific location types (cities rank above countries for a
// city-level search), then shorter names.
const TYPE_RANK: Record<string, number> = {
  City: 0,
  County: 1,
  Region: 2,
  State: 3,
  Country: 4,
}

function scoreLocation(loc: DfsLabsLocation, q: string): number {
  const name = loc.location_name.toLowerCase()
  if (name === q) return 0
  if (name.startsWith(q)) return 1
  if (name.startsWith(`${q},`)) return 1
  if (name.includes(q)) return 2
  return 3
}

/**
 * GET /api/dataforseo/locations?q=atlanta&country=US
 *
 * Returns up to MAX_RESULTS Labs locations matching the query, ordered by
 * relevance. Query is case-insensitive substring match against the full
 * location_name. Without a query, returns the "popular" set: the country
 * itself plus its direct children (states/regions), which gives a useful
 * baseline list before the user starts typing.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase()
    const country = (
      url.searchParams.get("country") ?? DEFAULT_COUNTRY
    ).toUpperCase()

    // Whole list is already scoped to the requested country by
    // listLabsLocations (it hits /v3/keywords_data/google_ads/locations/{cc}).
    const scoped = await listLabsLocations(country)

    if (!q) {
      // No query: return the country row + its direct children (states/regions).
      const country_row = scoped.find((l) => l.location_type === "Country")
      const children = country_row
        ? scoped
            .filter(
              (l) =>
                l.location_code_parent === country_row.location_code &&
                (l.location_type === "State" || l.location_type === "Region"),
            )
            .sort((a, b) => a.location_name.localeCompare(b.location_name))
        : []
      const results = country_row ? [country_row, ...children] : children
      return NextResponse.json({
        results: results.slice(0, MAX_RESULTS),
        total: results.length,
      })
    }

    const scored = scoped
      .map((loc) => ({ loc, tier: scoreLocation(loc, q) }))
      .filter((x) => x.tier < 3)
      .sort((a, b) => {
        if (a.tier !== b.tier) return a.tier - b.tier
        const typeA = TYPE_RANK[a.loc.location_type] ?? 99
        const typeB = TYPE_RANK[b.loc.location_type] ?? 99
        if (typeA !== typeB) return typeA - typeB
        return a.loc.location_name.length - b.loc.location_name.length
      })

    const results = scored.slice(0, MAX_RESULTS).map((x) => x.loc)
    return NextResponse.json({ results, total: scored.length })
  } catch (error: unknown) {
    console.error("[api/dataforseo/locations] failed:", error)
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
