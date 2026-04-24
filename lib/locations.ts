/**
 * Airtable → DataForSEO location parsing.
 *
 * Partner.serviceAreas is free-text ("Peachtree City, GA", "Atlanta, Georgia",
 * "Greensboro and Winston Salem, North Carolina"). DataForSEO wants
 * "City,FullStateName,United States" (no spaces after commas).
 *
 * parseLocation → canonical DFS string, or raw input if parsing fails. We
 * deliberately do NOT swap to a default location — surfacing the DFS error
 * is more honest than silently pretending the partner is in Mountain View.
 *
 * parseLocationCities → list of city names pulled from the first line, split
 * on " and " / " & " so "Greensboro and Winston Salem" yields both cities.
 * Used to build default seeds.
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

function resolveStateName(raw: string): string | null {
  const stateRaw = raw.replace(/,\s*(united states|usa|us)\s*\.?$/i, "").trim()
  if (/^[A-Za-z]{2}$/.test(stateRaw)) {
    return US_STATE_ABBREV[stateRaw.toUpperCase()] ?? null
  }
  return US_STATE_FROM_NAME.get(stateRaw.toLowerCase()) ?? null
}

/**
 * DataForSEO location candidates ordered from most to least specific.
 *
 * When parsing succeeds, returns [city-state-country, state-country,
 * "United States"]. Callers should try them in order and fall back on
 * 40501 "Invalid Field: location_name" — many smaller US cities are not
 * in DFS's location taxonomy, and falling back to the state is the
 * correct behavior for local-SEO keyword research.
 *
 * When parsing fails, returns [raw] so DataForSEO surfaces the underlying
 * error rather than silently swapping to a default (per CLAUDE.md).
 */
export function parseLocationCandidates(raw: string): string[] {
  const line = firstLine(raw)
  if (!line) return [raw]

  const commaIdx = line.indexOf(",")
  if (commaIdx <= 0) return [raw]

  const cityPart = line.slice(0, commaIdx).trim()
  const stateRaw = line.slice(commaIdx + 1).trim()

  const stateName = resolveStateName(stateRaw)
  if (!stateName) return [raw]

  const cities = splitCities(cityPart)
  const primaryCity = cities[0]
  const candidates: string[] = []
  if (primaryCity) {
    candidates.push(`${primaryCity},${stateName},United States`)
  }
  candidates.push(`${stateName},United States`)
  candidates.push("United States")
  return candidates
}

/**
 * Convenience wrapper for UIs that only need the most specific string to
 * display. Returns the top candidate from parseLocationCandidates.
 */
export function parseLocation(raw: string): string {
  return parseLocationCandidates(raw)[0] ?? raw
}

/** City names for seed-keyword generation. */
export function parseLocationCities(raw: string): string[] {
  const line = firstLine(raw)
  if (!line) return []
  const commaIdx = line.indexOf(",")
  const cityPart = commaIdx > 0 ? line.slice(0, commaIdx) : line
  return splitCities(cityPart)
}
