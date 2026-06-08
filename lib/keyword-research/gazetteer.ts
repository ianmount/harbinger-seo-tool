/**
 * Offline US place gazetteer for the keyword-research geo filter.
 *
 * The skill uses Python's `geonamescache` (~3,400 cities) to detect place
 * names in candidate keywords and drop the ones that aren't in the target
 * market. There's no Python at runtime here, so this is a vendored, hand-
 * curated subset: all 50 states (+ DC) by name and abbreviation, plus the
 * most common US cities used as keyword geo-modifiers.
 *
 * Design notes:
 *   - The geo filter is an ALLOWLIST: a keyword is only dropped when it
 *     contains a *known* place that is NOT in the run's market allowlist.
 *     Places we don't know about simply survive to manual review — we never
 *     wrongly drop an in-market term we failed to recognize.
 *   - It's a cost optimization, not a correctness gate: the localize phase
 *     already drops any term with zero city volume, which removes most
 *     out-of-market geo terms regardless. So an incomplete list is fine.
 *   - Ambiguous city names that double as common English words (Mobile,
 *     Reading, Surprise, Sandwich, …) are deliberately omitted to avoid
 *     false-positive drops. Extend `MAJOR_US_CITIES` as needed.
 */

export const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
  MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
  OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin",
  WY: "Wyoming", DC: "District of Columbia",
}

/**
 * Common US cities used as keyword geo-modifiers. Lowercased. Multi-word
 * cities are matched as phrases. Ambiguous common-word names are excluded.
 */
export const MAJOR_US_CITIES: readonly string[] = [
  "new york", "los angeles", "chicago", "houston", "phoenix", "philadelphia",
  "san antonio", "san diego", "dallas", "san jose", "austin", "jacksonville",
  "fort worth", "columbus", "charlotte", "san francisco", "indianapolis",
  "seattle", "denver", "oklahoma city", "nashville", "el paso", "boston",
  "portland", "las vegas", "detroit", "memphis", "louisville", "baltimore",
  "milwaukee", "albuquerque", "tucson", "fresno", "sacramento", "kansas city",
  "atlanta", "omaha", "colorado springs", "raleigh", "virginia beach",
  "long beach", "miami", "oakland", "minneapolis", "tulsa", "bakersfield",
  "wichita", "arlington", "aurora", "tampa", "new orleans", "cleveland",
  "honolulu", "anaheim", "lexington", "stockton", "corpus christi", "henderson",
  "riverside", "newark", "saint paul", "santa ana", "cincinnati", "irvine",
  "orlando", "pittsburgh", "st louis", "saint louis", "greensboro", "lincoln",
  "plano", "anchorage", "durham", "jersey city", "chandler", "chula vista",
  "buffalo", "north las vegas", "gilbert", "madison", "reno", "toledo",
  "fort wayne", "lubbock", "st petersburg", "saint petersburg", "laredo",
  "irving", "chesapeake", "winston salem", "glendale", "scottsdale",
  "garland", "boise", "norfolk", "spokane", "fremont", "huntsville",
  "san bernardino", "tacoma", "fontana", "rochester", "fayetteville",
  "moreno valley", "des moines", "yonkers", "overland park", "tempe",
  "mckinney", "augusta", "salt lake city", "cape coral", "grand rapids",
  "shreveport", "knoxville", "akron", "brownsville", "newport news",
  "providence", "fort lauderdale", "elk grove", "rancho cucamonga",
  "santa clarita", "oceanside", "sioux falls", "peoria", "ontario",
  "vancouver", "cary", "santa rosa", "salem", "eugene", "fort collins",
  "corona", "lakewood", "pembroke pines", "hayward", "hollywood",
  "escondido", "naperville", "alexandria", "sunnyvale", "savannah",
  "pasadena", "joliet", "paterson", "torrance", "bridgeport", "lafayette",
  "macon", "kissimmee", "clearwater", "athens", "marietta", "alpharetta",
  "roswell", "sandy springs", "decatur", "smyrna", "newnan", "peachtree city",
]

const STATE_NAMES_LOWER = new Set(
  Object.values(US_STATES).map((s) => s.toLowerCase()),
)

/**
 * Every known place token (single word) + a set of known multi-word place
 * phrases, all lowercased. Single tokens are matched against keyword words;
 * phrases are matched as substrings.
 */
export interface Gazetteer {
  /** Single-word place tokens (one-word state names + one-word cities). */
  singleTokens: Set<string>
  /** Multi-word place phrases ("san diego", "new york", "north carolina"). */
  phrases: string[]
}

let cached: Gazetteer | null = null

export function getGazetteer(): Gazetteer {
  if (cached) return cached
  const singleTokens = new Set<string>()
  const phrases: string[] = []

  const add = (name: string) => {
    const n = name.toLowerCase().trim()
    if (!n) return
    if (n.includes(" ")) phrases.push(n)
    else singleTokens.add(n)
  }

  // State NAMES and cities only. Two-letter state ABBREVIATIONS are
  // deliberately NOT in the match set — they collide with common English
  // words ("or", "in", "me", "hi", "ok", "id", "co", "ne", "wa", "de", "pa")
  // and would wrongly drop terms like "plumber in atlanta". Abbreviations are
  // used only for input parsing and allowlist expansion (see expandStateToken).
  for (const name of STATE_NAMES_LOWER) add(name)
  for (const city of MAJOR_US_CITIES) add(city)

  // Longest phrases first so "north las vegas" matches before "las vegas".
  phrases.sort((a, b) => b.length - a.length)
  cached = { singleTokens, phrases }
  return cached
}

/** Expand a state token (name or abbrev) to both forms, lowercased. */
export function expandStateToken(token: string): string[] {
  const t = token.trim().toLowerCase()
  const upper = token.trim().toUpperCase()
  const out = new Set<string>([t])
  if (US_STATES[upper]) out.add(US_STATES[upper].toLowerCase())
  // name → abbrev
  for (const [ab, name] of Object.entries(US_STATES)) {
    if (name.toLowerCase() === t) out.add(ab.toLowerCase())
  }
  return [...out]
}
