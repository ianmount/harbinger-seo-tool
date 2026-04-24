/**
 * Airtable → DataForSEO location helpers.
 *
 * Partner.serviceAreas is totally free-text (simple "Peachtree City, GA" all
 * the way to multi-line markdown with links). DFS's Labs endpoints want a
 * `location_name` that exactly matches their taxonomy — trying to auto-infer
 * city-level locations isn't reliable (many US cities aren't in the DFS
 * taxonomy and get rejected with status 40501).
 *
 * The UI picks a location manually from US_DFS_LOCATIONS. These helpers
 * provide a smart default (findSuggestedDfsLocation) and seed-generation
 * support (parseLocationCities).
 */

const US_STATE_ABBREV: Record<string, string> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  DC: "District of Columbia",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
}

const US_STATE_FROM_NAME = new Map<string, string>(
  Object.values(US_STATE_ABBREV).map((name) => [name.toLowerCase(), name]),
)

function firstLine(raw: string): string {
  return raw.split(/[\n;]/)[0].trim()
}

function splitCities(cityPart: string): string[] {
  return cityPart
    .split(/\s+(?:and|&)\s+|\s*\/\s*/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * Known-valid DataForSEO Labs location strings. "United States" covers the
 * whole country; state-level strings (e.g. "Georgia,United States") all
 * exist in DFS's taxonomy. City-level strings are not included here because
 * DFS's city coverage is spotty — cities can be added via the "Custom…"
 * input.
 */
export const US_DFS_LOCATIONS: readonly string[] = Object.freeze([
  "United States",
  ...Object.values(US_STATE_ABBREV)
    .slice()
    .sort()
    .map((name) => `${name},United States`),
])

/**
 * Best-effort suggested DFS location for a partner. Scans the full
 * serviceAreas text for any ", ST" (2-letter code) or state-name mention and
 * returns the corresponding "{State},United States" string. Falls back to
 * "United States" if nothing matches.
 */
export function findSuggestedDfsLocation(raw: string): string {
  if (!raw) return "United States"
  const abbrevMatch = raw.match(/(?:[,\s])([A-Z]{2})\b/)
  if (abbrevMatch) {
    const full = US_STATE_ABBREV[abbrevMatch[1]]
    if (full) return `${full},United States`
  }
  const lower = raw.toLowerCase()
  for (const [nameLower, properName] of US_STATE_FROM_NAME.entries()) {
    const re = new RegExp(`\\b${nameLower.replace(/\s+/g, "\\s+")}\\b`, "i")
    if (re.test(lower)) return `${properName},United States`
  }
  return "United States"
}

/** City names for seed-keyword generation. */
export function parseLocationCities(raw: string): string[] {
  const line = firstLine(raw)
  if (!line) return []
  const commaIdx = line.indexOf(",")
  const cityPart = commaIdx > 0 ? line.slice(0, commaIdx) : line
  return splitCities(cityPart)
}
