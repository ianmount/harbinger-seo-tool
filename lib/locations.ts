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

/**
 * Canonical DataForSEO location string, or the raw input if parsing fails.
 * Uses only the first listed city ("Greensboro and Winston Salem, NC" →
 * "Greensboro,North Carolina,United States") since DFS location_name must
 * resolve to a single place.
 */
export function parseLocation(raw: string): string {
  const line = firstLine(raw)
  if (!line) return raw

  const commaIdx = line.indexOf(",")
  if (commaIdx <= 0) return raw

  const cityPart = line.slice(0, commaIdx).trim()
  let stateRaw = line.slice(commaIdx + 1).trim()
  stateRaw = stateRaw.replace(/,\s*(united states|usa|us)\s*\.?$/i, "").trim()

  const cities = splitCities(cityPart)
  const primaryCity = cities[0]
  if (!primaryCity) return raw

  if (/^[A-Za-z]{2}$/.test(stateRaw)) {
    const full = US_STATE_ABBREV[stateRaw.toUpperCase()]
    if (full) return `${primaryCity},${full},United States`
  }
  const fromName = US_STATE_FROM_NAME.get(stateRaw.toLowerCase())
  if (fromName) return `${primaryCity},${fromName},United States`

  return raw
}

/** City names for seed-keyword generation. */
export function parseLocationCities(raw: string): string[] {
  const line = firstLine(raw)
  if (!line) return []
  const commaIdx = line.indexOf(",")
  const cityPart = commaIdx > 0 ? line.slice(0, commaIdx) : line
  return splitCities(cityPart)
}
