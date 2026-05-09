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
