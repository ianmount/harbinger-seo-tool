import type { DfsLabsLocation, KeywordResult } from "@/lib/types"

/**
 * State-name backstop for keyword candidates from DFS.
 *
 * Even with location-aware seeds, `keyword_suggestions` will sometimes return
 * a candidate that mentions an out-of-area state — usually a high-volume
 * national term that incidentally contains a state name. We drop those.
 *
 * We deliberately do NOT match two-letter state abbreviations: too many
 * collisions with English words (`in`, `or`, `ok`, `me`, `hi`, `id`, `pa`,
 * `la`, `de`, `co`, `al`, `ma`). False positives are far worse than letting a
 * stray `tx` slip through — the volume + maxKeywords cap downstream catches
 * the leftovers.
 */

const US_STATE_NAMES = [
  "alabama",
  "alaska",
  "arizona",
  "arkansas",
  "california",
  "colorado",
  "connecticut",
  "delaware",
  "florida",
  "georgia",
  "hawaii",
  "idaho",
  "illinois",
  "indiana",
  "iowa",
  "kansas",
  "kentucky",
  "louisiana",
  "maine",
  "maryland",
  "massachusetts",
  "michigan",
  "minnesota",
  "mississippi",
  "missouri",
  "montana",
  "nebraska",
  "nevada",
  "new hampshire",
  "new jersey",
  "new mexico",
  "new york",
  "north carolina",
  "north dakota",
  "ohio",
  "oklahoma",
  "oregon",
  "pennsylvania",
  "rhode island",
  "south carolina",
  "south dakota",
  "tennessee",
  "texas",
  "utah",
  "vermont",
  "virginia",
  "washington",
  "west virginia",
  "wisconsin",
  "wyoming",
] as const

type UsStateName = (typeof US_STATE_NAMES)[number]

const ALL_STATES_PATTERN = new RegExp(
  `\\b(${US_STATE_NAMES.join("|")})\\b`,
  "i",
)

/** Extract the lowercase state names mentioned by the user's selected locations. */
export function extractAllowedStates(
  locations: ReadonlyArray<DfsLabsLocation>,
): Set<UsStateName> {
  const allowed = new Set<UsStateName>()
  for (const loc of locations) {
    // location_name like "Atlanta,Georgia,United States" or "Georgia,United States"
    const text = loc.location_name.toLowerCase()
    for (const state of US_STATE_NAMES) {
      const re = new RegExp(`\\b${state}\\b`, "i")
      if (re.test(text)) allowed.add(state)
    }
  }
  return allowed
}

/**
 * Drop keywords that mention a US state name not in the allowed set. Keywords
 * with no state mention pass through unchanged.
 */
export function filterOutOfAreaKeywords(
  keywords: ReadonlyArray<KeywordResult>,
  allowedStates: ReadonlySet<UsStateName>,
): { kept: KeywordResult[]; dropped: number } {
  const kept: KeywordResult[] = []
  let dropped = 0
  for (const kw of keywords) {
    const match = kw.keyword.toLowerCase().match(ALL_STATES_PATTERN)
    if (!match) {
      kept.push(kw)
      continue
    }
    const state = match[1] as UsStateName
    if (allowedStates.has(state)) {
      kept.push(kw)
    } else {
      dropped++
    }
  }
  return { kept, dropped }
}

/**
 * Drop "near me" candidates whose geo-bound twin is already in the pool.
 *
 * `keyword_suggestions` runs at country level, where `<service> near me`
 * variants carry national volume that swamps city-bound twins like
 * `<service> <city>`. After volume enrichment a near-me term still beats its
 * local twin on raw volume, so the per-location top-N cap surfaces nothing
 * but near-me. This helper preserves a near-me candidate only when no local
 * alternative exists, i.e. the near-me phrase is the only way the user can
 * see this intent for the selected location.
 *
 * "Twin" definition: a non-near-me keyword in the same pool that contains
 *   1. every word of the near-me phrase's core (the phrase minus "near me"), and
 *   2. at least one phrase from the selected location (city or state name).
 */
const NEAR_ME_PATTERN = /\bnear me\b/i

function normalizePadded(s: string): string {
  return ` ${s.toLowerCase().trim().replace(/\s+/g, " ")} `
}

export function extractLocationPhrases(
  locations: ReadonlyArray<DfsLabsLocation>,
): string[] {
  const out = new Set<string>()
  for (const loc of locations) {
    for (const part of loc.location_name.split(",")) {
      const cleaned = part.trim().toLowerCase()
      if (!cleaned || cleaned === "united states") continue
      out.add(cleaned)
    }
  }
  return Array.from(out)
}

/**
 * Partition a candidate pool for a specific location tab in a multi-location
 * run. Drops keywords that mention any OTHER selected location (e.g. "plumber
 * boston" should not appear in the Atlanta tab). Keywords that mention this
 * location, or no selected location at all (location-agnostic head terms),
 * pass through.
 *
 * Single-location runs are a no-op since there are no "other" locations.
 */
export function partitionForLocation(
  candidates: ReadonlyArray<KeywordResult>,
  loc: DfsLabsLocation,
  allLocations: ReadonlyArray<DfsLabsLocation>,
): { kept: KeywordResult[]; dropped: number } {
  const otherLocations = allLocations.filter(
    (l) => l.location_code !== loc.location_code,
  )
  const otherPhrases = extractLocationPhrases(otherLocations)
  if (otherPhrases.length === 0) {
    return { kept: candidates.slice(), dropped: 0 }
  }
  const kept: KeywordResult[] = []
  let dropped = 0
  for (const kw of candidates) {
    const text = kw.keyword.toLowerCase()
    if (otherPhrases.some((p) => text.includes(p))) {
      dropped++
    } else {
      kept.push(kw)
    }
  }
  return { kept, dropped }
}

export function dedupeNearMeAgainstGeoTwins(
  keywords: ReadonlyArray<KeywordResult>,
  locations: ReadonlyArray<DfsLabsLocation>,
): { kept: KeywordResult[]; dropped: number } {
  const locPhrases = extractLocationPhrases(locations)
  if (locPhrases.length === 0) {
    return { kept: keywords.slice(), dropped: 0 }
  }

  const nonNearMePadded: string[] = []
  for (const kw of keywords) {
    if (!NEAR_ME_PATTERN.test(kw.keyword)) {
      nonNearMePadded.push(normalizePadded(kw.keyword))
    }
  }

  const kept: KeywordResult[] = []
  let dropped = 0
  for (const kw of keywords) {
    if (!NEAR_ME_PATTERN.test(kw.keyword)) {
      kept.push(kw)
      continue
    }
    const core = kw.keyword
      .toLowerCase()
      .replace(NEAR_ME_PATTERN, " ")
      .replace(/\s+/g, " ")
      .trim()
    const coreTokens = core.split(" ").filter(Boolean)
    if (coreTokens.length === 0) {
      // Bare "near me" with no service prefix — nothing to find a twin for.
      kept.push(kw)
      continue
    }
    const hasTwin = nonNearMePadded.some((padded) => {
      for (const token of coreTokens) {
        if (!padded.includes(` ${token} `)) return false
      }
      return locPhrases.some((phrase) => padded.includes(phrase))
    })
    if (hasTwin) {
      dropped++
    } else {
      kept.push(kw)
    }
  }
  return { kept, dropped }
}
