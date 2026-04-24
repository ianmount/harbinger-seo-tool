import "server-only"
import { z } from "zod"
import { requireEnv } from "@/lib/env"
import type {
  CompetitionLevel,
  DfsLabsLocation,
  DfsLocation,
  KeywordResult,
} from "@/lib/types"

const DFS_BASE = "https://api.dataforseo.com"
const DEFAULT_LIMIT = 50
const DEFAULT_LANGUAGE = "English"
const DEFAULT_LANGUAGE_CODE = "en"
const RATE_LIMIT_RETRY_MS = 2000

export class DataForSEOError extends Error {
  readonly status: number | undefined
  readonly dfsStatus: number | undefined
  constructor(
    message: string,
    opts: { status?: number; dfsStatus?: number } = {},
  ) {
    super(message)
    this.name = "DataForSEOError"
    this.status = opts.status
    this.dfsStatus = opts.dfsStatus
  }
}

// Loose envelope — DataForSEO returns a consistent shape across endpoints.
// We validate the structure we depend on and let item shapes vary per endpoint.
const envelopeSchema = z
  .object({
    status_code: z.number(),
    status_message: z.string(),
    cost: z.number().optional(),
    tasks: z
      .array(
        z
          .object({
            status_code: z.number(),
            status_message: z.string(),
            cost: z.number().optional(),
            result_count: z.number().optional(),
            result: z.array(z.unknown()).nullable().optional(),
          })
          .passthrough(),
      )
      .optional()
      .default([]),
  })
  .passthrough()

type DfsEnvelope = z.infer<typeof envelopeSchema>

function authHeader(): string {
  const login = requireEnv("DATAFORSEO_LOGIN")
  const password = requireEnv("DATAFORSEO_PASSWORD")
  const token = Buffer.from(`${login}:${password}`).toString("base64")
  return `Basic ${token}`
}

// DataForSEO requires *paired* location + language fields:
//   - `location_code` must be paired with `language_code` (e.g. 2840 + "en")
//   - `location_name` must be paired with `language_name` (e.g. "United
//     States" + "English")
// Mixing them (location_code + language_name) yields a cryptic 40501
// "Invalid Field: 'location_code'" response — so we always emit the pair
// together and remove the standalone `language_name` from the request body.
function locationAndLanguageParams(
  location: DfsLocation,
): Record<string, string | number> {
  if ("code" in location) {
    return { location_code: location.code, language_code: DEFAULT_LANGUAGE_CODE }
  }
  return { location_name: location.name, language_name: DEFAULT_LANGUAGE }
}

export async function dfsRequest<T = DfsEnvelope>(
  endpoint: string,
  body: unknown,
): Promise<T> {
  const url = `${DFS_BASE}${endpoint}`
  const init: RequestInit = {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }

  let response = await fetch(url, init)
  if (response.status === 429) {
    await new Promise((r) => setTimeout(r, RATE_LIMIT_RETRY_MS))
    response = await fetch(url, init)
  }

  if (!response.ok) {
    const text = await response.text()
    throw new DataForSEOError(
      `DataForSEO HTTP ${response.status}: ${text.slice(0, 500)}`,
      { status: response.status },
    )
  }

  const json: unknown = await response.json()
  const parsed = envelopeSchema.safeParse(json)
  if (!parsed.success) {
    throw new DataForSEOError(
      `DataForSEO response did not match expected shape: ${parsed.error.message}`,
    )
  }
  const envelope = parsed.data

  console.log(
    `[dataforseo] endpoint=${endpoint} dfs_status=${envelope.status_code} cost=$${(envelope.cost ?? 0).toFixed(4)} tasks=${envelope.tasks.length}`,
  )

  if (envelope.status_code !== 20000) {
    throw new DataForSEOError(
      `DataForSEO returned status ${envelope.status_code}: ${envelope.status_message}`,
      { dfsStatus: envelope.status_code },
    )
  }

  // Per-task success check — decision 6A from planning: task-level failures
  // should throw so routes surface the underlying error. A task with
  // result_count=0 is NOT a failure (status_code will still be 20000).
  for (const task of envelope.tasks) {
    if (task.status_code !== 20000) {
      throw new DataForSEOError(
        `DataForSEO task failed with status ${task.status_code}: ${task.status_message}`,
        { dfsStatus: task.status_code },
      )
    }
  }

  return envelope as T
}

// ────────────────────────────────────────────────────────────────────────────
// Response item shapes. `passthrough()` allows extra fields we don't care
// about to pass through without validation errors.

const labsItemSchema = z
  .object({
    keyword: z.string(),
    keyword_info: z
      .object({
        search_volume: z.number().nullable().optional(),
        cpc: z.number().nullable().optional(),
        competition: z.number().nullable().optional(),
        competition_level: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    keyword_properties: z
      .object({
        keyword_difficulty: z.number().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    // bulk_keyword_difficulty items carry keyword_difficulty at the top level.
    keyword_difficulty: z.number().nullable().optional(),
  })
  .passthrough()

const googleAdsItemSchema = z
  .object({
    keyword: z.string(),
    search_volume: z.number().nullable().optional(),
    cpc: z.number().nullable().optional(),
    competition: z.string().nullable().optional(),
    competition_index: z.number().nullable().optional(),
  })
  .passthrough()

function toCompetitionLevel(v: unknown): CompetitionLevel | undefined {
  if (typeof v !== "string") return undefined
  const upper = v.toUpperCase()
  if (upper === "HIGH" || upper === "MEDIUM" || upper === "LOW") return upper
  return undefined
}

function normalizeLabsItem(raw: unknown): KeywordResult {
  const item = labsItemSchema.parse(raw)
  const info = item.keyword_info ?? undefined
  const props = item.keyword_properties ?? undefined
  return {
    keyword: item.keyword,
    search_volume: info?.search_volume ?? undefined,
    cpc: info?.cpc ?? undefined,
    competition: info?.competition ?? undefined,
    competition_level: toCompetitionLevel(info?.competition_level),
    keyword_difficulty:
      props?.keyword_difficulty ?? item.keyword_difficulty ?? undefined,
  }
}

function normalizeGoogleAdsItem(raw: unknown): KeywordResult {
  const item = googleAdsItemSchema.parse(raw)
  return {
    keyword: item.keyword,
    search_volume: item.search_volume ?? undefined,
    cpc: item.cpc ?? undefined,
    competition:
      item.competition_index != null ? item.competition_index / 100 : undefined,
    competition_level: toCompetitionLevel(item.competition),
  }
}

// For Labs endpoints the items live at tasks[0].result[0].items.
// For Google Ads search_volume they live at tasks[0].result directly.
function extractLabsItems(envelope: DfsEnvelope): unknown[] {
  const firstTask = envelope.tasks[0]
  if (!firstTask) return []
  const result = firstTask.result
  if (!result || result.length === 0) return []
  const firstResult = result[0] as { items?: unknown[] } | null
  return firstResult?.items ?? []
}

function extractGoogleAdsItems(envelope: DfsEnvelope): unknown[] {
  const firstTask = envelope.tasks[0]
  if (!firstTask) return []
  return firstTask.result ?? []
}

// ────────────────────────────────────────────────────────────────────────────
// Typed wrappers.

export async function keywordIdeas(
  seed: string,
  location: DfsLocation,
  opts: { limit?: number } = {},
): Promise<KeywordResult[]> {
  const envelope = await dfsRequest(
    "/v3/dataforseo_labs/google/keyword_ideas/live",
    [
      {
        keywords: [seed],
        ...locationAndLanguageParams(location),
        limit: opts.limit ?? DEFAULT_LIMIT,
      },
    ],
  )
  return extractLabsItems(envelope).map(normalizeLabsItem)
}

export async function keywordSuggestions(
  seed: string,
  location: DfsLocation,
  opts: { limit?: number } = {},
): Promise<KeywordResult[]> {
  const envelope = await dfsRequest(
    "/v3/dataforseo_labs/google/keyword_suggestions/live",
    [
      {
        keyword: seed,
        ...locationAndLanguageParams(location),
        limit: opts.limit ?? DEFAULT_LIMIT,
      },
    ],
  )
  return extractLabsItems(envelope).map(normalizeLabsItem)
}

export async function bulkKeywordDifficulty(
  keywords: string[],
  location: DfsLocation,
): Promise<KeywordResult[]> {
  if (keywords.length === 0) return []
  const envelope = await dfsRequest(
    "/v3/dataforseo_labs/google/bulk_keyword_difficulty/live",
    [
      {
        keywords,
        ...locationAndLanguageParams(location),
      },
    ],
  )
  return extractLabsItems(envelope).map(normalizeLabsItem)
}

export async function searchVolume(
  keywords: string[],
  location: DfsLocation,
): Promise<KeywordResult[]> {
  if (keywords.length === 0) return []
  const envelope = await dfsRequest(
    "/v3/keywords_data/google_ads/search_volume/live",
    [
      {
        keywords,
        ...locationAndLanguageParams(location),
      },
    ],
  )
  return extractGoogleAdsItems(envelope).map(normalizeGoogleAdsItem)
}

// ────────────────────────────────────────────────────────────────────────────
// Location taxonomy.
//
// DataForSEO Labs' keyword_ideas / keyword_suggestions / bulk_keyword_difficulty
// endpoints are picky about `location_name` (a lot of cities that exist in the
// Google Ads location list are rejected at the Labs layer with status 40501).
// The reliable path is `location_code` — numeric IDs that map 1:1 to locations
// in DFS's Labs taxonomy. This helper fetches the full list once per process
// so the UI can offer a searchable picker and callers can pass codes.

const labsLocationItemSchema = z
  .object({
    location_code: z.number(),
    location_name: z.string(),
    location_code_parent: z.number().nullable().optional(),
    country_iso_code: z.string().nullable().optional(),
    location_type: z.string(),
  })
  .passthrough()

let cachedLocations: DfsLabsLocation[] | null = null
let cachedLocationsFetchedAt = 0
let cachedLocationsCountry = ""
const LOCATIONS_CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24h

/**
 * Fetch DataForSEO's Google Ads location list for a country. We use the
 * Google Ads locations endpoint (not /v3/dataforseo_labs/locations_and_languages
 * — that one only returns countries with their supported languages, not
 * the full city/state taxonomy we need for keyword research). The
 * location_code values returned here are Google's canonical IDs and work
 * directly with DataForSEO Labs endpoints.
 *
 * Cached in-process for 24h because the taxonomy changes rarely and the
 * response is large (US alone is ~100k rows). First call after cold start
 * pays one DFS request (several seconds); subsequent calls return cache.
 */
export async function listLabsLocations(
  countryIsoCode = "US",
): Promise<DfsLabsLocation[]> {
  const country = countryIsoCode.toUpperCase()
  const now = Date.now()
  if (
    cachedLocations &&
    cachedLocationsCountry === country &&
    now - cachedLocationsFetchedAt < LOCATIONS_CACHE_TTL_MS
  ) {
    return cachedLocations
  }

  const url = `${DFS_BASE}/v3/keywords_data/google_ads/locations/${country}`
  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: authHeader() },
  })

  if (!response.ok) {
    const text = await response.text()
    throw new DataForSEOError(
      `DataForSEO HTTP ${response.status} fetching locations for ${country}: ${text.slice(0, 500)}`,
      { status: response.status },
    )
  }

  const json: unknown = await response.json()
  const parsed = envelopeSchema.safeParse(json)
  if (!parsed.success) {
    throw new DataForSEOError(
      `DataForSEO locations response did not match expected shape: ${parsed.error.message}`,
    )
  }
  const envelope = parsed.data
  if (envelope.status_code !== 20000) {
    throw new DataForSEOError(
      `DataForSEO locations returned status ${envelope.status_code}: ${envelope.status_message}`,
      { dfsStatus: envelope.status_code },
    )
  }

  const firstTask = envelope.tasks[0]
  const rawItems = firstTask?.result ?? []
  const locations: DfsLabsLocation[] = []
  for (const raw of rawItems) {
    const item = labsLocationItemSchema.safeParse(raw)
    if (!item.success) continue
    locations.push({
      location_code: item.data.location_code,
      location_name: item.data.location_name,
      location_code_parent: item.data.location_code_parent ?? null,
      country_iso_code: item.data.country_iso_code ?? null,
      location_type: item.data.location_type,
    })
  }

  cachedLocations = locations
  cachedLocationsFetchedAt = now
  cachedLocationsCountry = country
  console.log(
    `[dataforseo] cached ${locations.length} locations for country=${country}`,
  )
  return locations
}
