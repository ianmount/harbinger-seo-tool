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
 * Return the full set of locations under a country (including the country
 * row itself), walking the parent chain. Necessary because DFS Labs may
 * not populate `country_iso_code` on state/city rows — only `location_code_parent`
 * is reliable for establishing hierarchy.
 */
function locationsUnderCountry(
  all: DfsLabsLocation[],
  countryIso: string,
): DfsLabsLocation[] {
  const countryRow = all.find(
    (l) =>
      l.location_type === "Country" &&
      (l.country_iso_code ?? "").toUpperCase() === countryIso,
  )
  if (!countryRow) return []

  const childrenOf = new Map<number, DfsLabsLocation[]>()
  for (const l of all) {
    if (l.location_code_parent == null) continue
    const list = childrenOf.get(l.location_code_parent) ?? []
    list.push(l)
    childrenOf.set(l.location_code_parent, list)
  }

  const result: DfsLabsLocation[] = [countryRow]
  const queue: number[] = [countryRow.location_code]
  while (queue.length > 0) {
    const parent = queue.shift()!
    const kids = childrenOf.get(parent) ?? []
    for (const kid of kids) {
      result.push(kid)
      queue.push(kid.location_code)
    }
  }
  return result
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

    const all = await listLabsLocations()
    const scoped = locationsUnderCountry(all, country)

    if (!q) {
      // No query: return the country row + its direct children (states/regions).
      const countryRow = scoped.find((l) => l.location_type === "Country")
      const children = countryRow
        ? scoped
            .filter(
              (l) =>
                l.location_code_parent === countryRow.location_code &&
                (l.location_type === "State" || l.location_type === "Region"),
            )
            .sort((a, b) => a.location_name.localeCompare(b.location_name))
        : []
      const results = countryRow ? [countryRow, ...children] : children
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
