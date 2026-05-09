import "server-only"
import { z } from "zod"
import { recordDataForSEOCost } from "@/lib/audit-cost"
import { requireEnv } from "@/lib/env"
import type {
  BacklinkProfile,
  BacklinkProfileDomain,
  BacklinkReport,
  BacklinkTimeseriesPoint,
  CompetitionLevel,
  DfsLabsLocation,
  DfsLocation,
  DomainRankOverview,
  KeywordResult,
  ReferringDomain,
  ReferringDomainSample,
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
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const url = `${DFS_BASE}${endpoint}`
  // Per-attempt timeout. Native fetch has no body-read timeout — without
  // this, a hung TCP connection blocks the awaiting Promise.all in
  // mapWithConcurrency forever, eventually consuming the whole 800s
  // function budget for a single bad probe. 60s comfortably exceeds DFS's
  // typical 5-30s SERP latency while bounding worst-case stall.
  const timeoutMs = opts.timeoutMs ?? 60_000
  const buildSignal = (): AbortSignal => {
    const t = AbortSignal.timeout(timeoutMs)
    return opts.signal ? AbortSignal.any([t, opts.signal]) : t
  }
  const buildInit = (): RequestInit => ({
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: buildSignal(),
  })

  // Retry up to 3 times on 429 with exponential backoff + jitter so a
  // burst of parallel calls doesn't all bunch up at the same retry instant.
  let response = await fetch(url, buildInit())
  for (let attempt = 0; attempt < 3 && response.status === 429; attempt++) {
    const backoffMs =
      RATE_LIMIT_RETRY_MS * 2 ** attempt + Math.floor(Math.random() * 500)
    await new Promise((r) => setTimeout(r, backoffMs))
    response = await fetch(url, buildInit())
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

  const envelopeCost = envelope.cost ?? 0
  recordDataForSEOCost(envelopeCost)
  console.log(
    `[dataforseo] endpoint=${endpoint} dfs_status=${envelope.status_code} cost=$${envelopeCost.toFixed(4)} tasks=${envelope.tasks.length}`,
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

// ────────────────────────────────────────────────────────────────────────────
// Backlinks tab — referring_domains for competitor backlink research.
//
// A separate pass from `referringDomainsWithSpamScore` below (used by the
// Audit tab). That one computes spam/authority summaries for a single
// domain; this one surfaces *each* referring domain as a candidate prospect
// that the user can pitch for a link.

const backlinksTabDomainSchema = z
  .object({
    // DataForSEO sometimes returns "domain"; in some response shapes the field
    // is named slightly differently. `.passthrough()` below lets us stay
    // forgiving on unknown fields while validating the ones we consume.
    domain: z.string(),
    rank: z.number().nullable().optional(),
    backlinks: z.number().nullable().optional(),
    backlinks_spam_score: z.number().nullable().optional(),
    first_seen: z.string().nullable().optional(),
  })
  .passthrough()

function extractBacklinksItems(envelope: DfsEnvelope): unknown[] {
  // /v3/backlinks/referring_domains/live places items under
  // tasks[0].result[0].items — same shape as DFS Labs endpoints.
  const firstTask = envelope.tasks[0]
  if (!firstTask) return []
  const result = firstTask.result
  if (!result || result.length === 0) return []
  const firstResult = result[0] as { items?: unknown[] } | null
  return firstResult?.items ?? []
}

/**
 * Fetch referring domains for a target (competitor domain or URL) via
 * DataForSEO's backlinks/referring_domains/live endpoint.
 *
 * - `target` may be a bare domain ("example.com") or a URL; DataForSEO
 *   accepts either.
 * - `limit` is capped at 1000 by DataForSEO. Order defaults to rank desc so
 *   the highest-authority referrers come first.
 *
 * Returns a normalized ReferringDomain list with `referringTo` set to the
 * original target so the caller can merge results from multiple competitors
 * and still trace each prospect back to its source.
 */
export async function referringDomains(
  target: string,
  limit: number,
): Promise<ReferringDomain[]> {
  const trimmed = target.trim()
  if (!trimmed) return []
  const envelope = await dfsRequest(
    "/v3/backlinks/referring_domains/live",
    [
      {
        target: trimmed,
        limit: Math.min(Math.max(limit, 1), 1000),
        order_by: ["rank,desc"],
      },
    ],
  )
  const items = extractBacklinksItems(envelope)
  const out: ReferringDomain[] = []
  for (const raw of items) {
    const parsed = backlinksTabDomainSchema.safeParse(raw)
    if (!parsed.success) continue
    const d = parsed.data
    if (!d.domain) continue
    out.push({
      domain: d.domain,
      rank: d.rank ?? 0,
      backlinks: d.backlinks ?? 0,
      spamScore: d.backlinks_spam_score ?? 0,
      firstSeen: d.first_seen ?? undefined,
      referringTo: trimmed,
    })
  }
  return out
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

// Hardcoded country code for all Labs keyword_ideas / keyword_suggestions /
// bulk_keyword_difficulty calls. DataForSEO Labs' keyword research endpoints
// only accept country-level location codes (their
// /v3/dataforseo_labs/locations_and_languages list contains no states/cities —
// verified against live API 2026-04-24). Local-volume data comes from a
// separate Google Ads search_volume enrichment pass that DOES support cities.
export const DFS_LABS_COUNTRY_CODE_US = 2840

/**
 * Fetch DataForSEO's Google Ads location list for a country. These are
 * Google Ads codes and work with /v3/keywords_data/google_ads/search_volume
 * (the endpoint we use for city-level volume data). They do NOT work with
 * Labs endpoints — Labs has a separate taxonomy that's country-only.
 *
 * Cached in-process for 24h. Response for US is large (~100k rows);
 * subsequent calls return cache.
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
    `[dataforseo] cached ${locations.length} Google Ads locations for ${country}`,
  )
  return locations
}


// ────────────────────────────────────────────────────────────────────────────
// Audit tab wrappers.
//
// These five functions power the SEO Audit pipeline. They're grouped at the
// bottom so the existing Keyword Research imports don't need to change.
//
// Cost notes (approximate, verify against DataForSEO's current price list):
//   - domain_rank_overview: ~$0.0001/call
//   - ranked_keywords:       ~$0.01/call (up to 100 rows)
//   - serp live:             ~$0.002/call
//   - backlinks/summary:     ~$0.02/call
//   - backlinks/referring_domains: ~$0.02/call (up to 100 rows)
// A full audit with 3 markets + 4 competitors runs ~$0.40 in DataForSEO.

function stripDomain(domain: string): string {
  return domain
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase()
}

const domainRankItemSchema = z
  .object({
    metrics: z
      .object({
        organic: z
          .object({
            count: z.number().nullable().optional(),
            etv: z.number().nullable().optional(),
            estimated_paid_traffic_cost: z.number().nullable().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
        paid: z
          .object({
            count: z.number().nullable().optional(),
            etv: z.number().nullable().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .optional(),
    location_code: z.number().optional(),
    location_name: z.string().nullable().optional(),
  })
  .passthrough()

/**
 * /v3/dataforseo_labs/google/domain_rank_overview/live
 *
 * Returns visibility totals (organic keywords, estimated traffic, estimated
 * traffic cost) for a domain in a given Google Ads location. Used for the
 * competitive comparison table in the audit.
 */
export async function domainRankOverview(
  domain: string,
  location: DfsLocation,
): Promise<DomainRankOverview> {
  const target = stripDomain(domain)
  const envelope = await dfsRequest(
    "/v3/dataforseo_labs/google/domain_rank_overview/live",
    [
      {
        target,
        ...locationAndLanguageParams(location),
      },
    ],
  )
  const items = extractLabsItems(envelope)
  const first = items[0] ?? null
  const parsed = domainRankItemSchema.safeParse(first ?? {})
  const item = parsed.success ? parsed.data : {}
  const locationCode =
    "code" in location
      ? location.code
      : (item.location_code ?? 0)
  const locationName = item.location_name ?? ("name" in location ? location.name : "")
  return {
    domain: target,
    locationCode,
    locationName: locationName ?? "",
    organicKeywords: item.metrics?.organic?.count ?? 0,
    organicTraffic: item.metrics?.organic?.etv ?? 0,
    organicTrafficCost:
      item.metrics?.organic?.estimated_paid_traffic_cost ?? 0,
    paidKeywords: item.metrics?.paid?.count ?? 0,
    paidTraffic: item.metrics?.paid?.etv ?? 0,
  }
}

const rankedKeywordItemSchema = z
  .object({
    keyword_data: z
      .object({
        keyword: z.string(),
        keyword_info: z
          .object({
            search_volume: z.number().nullable().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough(),
    ranked_serp_element: z
      .object({
        serp_item: z
          .object({
            rank_absolute: z.number().nullable().optional(),
            rank_group: z.number().nullable().optional(),
            etv: z.number().nullable().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough()

export interface RankedKeyword {
  keyword: string
  position: number
  searchVolume: number
  estimatedTraffic: number
}

/**
 * /v3/dataforseo_labs/google/ranked_keywords/live
 *
 * Pulls the top N keywords a domain ranks for in a given location. Used by
 * the audit's competitive comparison to surface the 3-5 highest-traffic
 * keywords per domain × market cell.
 */
export async function rankedKeywords(
  domain: string,
  location: DfsLocation,
  opts: { limit?: number; minVolume?: number } = {},
): Promise<RankedKeyword[]> {
  const target = stripDomain(domain)
  const filters =
    opts.minVolume != null
      ? [["keyword_data.keyword_info.search_volume", ">", opts.minVolume]]
      : undefined
  const envelope = await dfsRequest(
    "/v3/dataforseo_labs/google/ranked_keywords/live",
    [
      {
        target,
        ...locationAndLanguageParams(location),
        limit: opts.limit ?? 100,
        order_by: ["ranked_serp_element.serp_item.etv,desc"],
        ...(filters ? { filters } : {}),
      },
    ],
  )
  const items = extractLabsItems(envelope)
  const out: RankedKeyword[] = []
  for (const raw of items) {
    const parsed = rankedKeywordItemSchema.safeParse(raw)
    if (!parsed.success) continue
    const kw = parsed.data
    const serp = kw.ranked_serp_element?.serp_item
    if (!serp) continue
    const position = serp.rank_absolute ?? serp.rank_group ?? 0
    if (!position) continue
    out.push({
      keyword: kw.keyword_data.keyword,
      position,
      searchVolume: kw.keyword_data.keyword_info?.search_volume ?? 0,
      estimatedTraffic: serp.etv ?? 0,
    })
  }
  return out
}

export interface SerpRankedDomain {
  domain: string
  rankAbsolute: number
  /** SERP result URL — empty string when DFS didn't surface one. */
  url: string
}

/**
 * /v3/serp/google/organic/live/advanced
 *
 * Like `serpCompetitors` but returns each organic result's rank position
 * alongside its domain — used by the Comp Analysis tab to compute
 * "domain ranks for X of N seed keywords in top 3/10/20/100 in city Y".
 *
 * Items are returned in SERP order. `rank_absolute` is the 1-indexed
 * position across all SERP elements (organic + ads + map pack); we filter
 * to `type === "organic"` so the position counts reflect organic
 * rankings only.
 *
 * The SERP endpoint accepts city-level Google Ads location codes (unlike
 * Labs endpoints which are country-only), so callers should pass the
 * city code directly here.
 */
export async function serpRankedDomains(
  keyword: string,
  location: DfsLocation,
  opts: { depth?: number; signal?: AbortSignal } = {},
): Promise<SerpRankedDomain[]> {
  const envelope = await dfsRequest(
    "/v3/serp/google/organic/live/advanced",
    [
      {
        keyword,
        ...locationAndLanguageParams(location),
        depth: opts.depth ?? 100,
      },
    ],
    { signal: opts.signal },
  )
  const firstTask = envelope.tasks[0]
  const result = firstTask?.result?.[0] as { items?: unknown[] } | undefined
  const items = result?.items ?? []
  const out: SerpRankedDomain[] = []
  for (const raw of items) {
    const parsed = serpItemSchema.safeParse(raw)
    if (!parsed.success) continue
    if (parsed.data.type !== "organic") continue
    const domain = parsed.data.domain
    const rankAbsolute = parsed.data.rank_absolute
    if (!domain || rankAbsolute == null) continue
    out.push({
      domain: domain.toLowerCase(),
      rankAbsolute,
      url: parsed.data.url ?? "",
    })
  }
  return out
}

const serpItemSchema = z
  .object({
    type: z.string().optional(),
    domain: z.string().nullable().optional(),
    rank_absolute: z.number().nullable().optional(),
    url: z.string().nullable().optional(),
  })
  .passthrough()

/**
 * /v3/serp/google/organic/live/advanced
 *
 * Runs a single SERP query and returns the top 10 organic result domains.
 * Used when the MD doesn't supply competitors — we take the top 3-5 seed
 * queries for the prospect's services, run each in each target market, and
 * aggregate the most-recurring domains as proposed competitors.
 */
export async function serpCompetitors(
  keyword: string,
  location: DfsLocation,
  opts: { depth?: number } = {},
): Promise<string[]> {
  const envelope = await dfsRequest(
    "/v3/serp/google/organic/live/advanced",
    [
      {
        keyword,
        ...locationAndLanguageParams(location),
        depth: opts.depth ?? 10,
      },
    ],
  )
  const firstTask = envelope.tasks[0]
  const result = firstTask?.result?.[0] as { items?: unknown[] } | undefined
  const items = result?.items ?? []
  const domains: string[] = []
  for (const raw of items) {
    const parsed = serpItemSchema.safeParse(raw)
    if (!parsed.success) continue
    if (parsed.data.type !== "organic") continue
    const domain = parsed.data.domain
    if (domain) domains.push(domain.toLowerCase())
  }
  return domains
}

const backlinksSummaryItemSchema = z
  .object({
    target: z.string().optional(),
    backlinks: z.number().nullable().optional(),
    referring_domains: z.number().nullable().optional(),
    referring_main_domains: z.number().nullable().optional(),
    backlinks_spam_score: z.number().nullable().optional(),
    rank: z.number().nullable().optional(),
    broken_backlinks: z.number().nullable().optional(),
    broken_pages: z.number().nullable().optional(),
  })
  .passthrough()

export interface BacklinkSummary {
  domain: string
  totalBacklinks: number
  referringDomains: number
  averageSpamScore: number
  rank: number
  brokenBacklinks: number
  brokenPages: number
}

/**
 * /v3/backlinks/summary/live
 *
 * Top-level backlink counts and the domain-wide average spam score. Cheap
 * single-call summary; we pair it with referring_domains below for concrete
 * spammy-domain examples in the audit.
 */
export async function backlinksSummary(
  domain: string,
): Promise<BacklinkSummary> {
  const target = stripDomain(domain)
  const envelope = await dfsRequest("/v3/backlinks/summary/live", [
    {
      target,
      internal_list_limit: 10,
      backlinks_status_type: "live",
    },
  ])
  const firstTask = envelope.tasks[0]
  const rawResult = firstTask?.result?.[0]
  const parsed = backlinksSummaryItemSchema.safeParse(rawResult ?? {})
  const item = parsed.success ? parsed.data : {}
  return {
    domain: target,
    totalBacklinks: item.backlinks ?? 0,
    referringDomains:
      item.referring_main_domains ?? item.referring_domains ?? 0,
    averageSpamScore: item.backlinks_spam_score ?? 0,
    rank: item.rank ?? 0,
    brokenBacklinks: item.broken_backlinks ?? 0,
    brokenPages: item.broken_pages ?? 0,
  }
}

const referringDomainItemSchema = z
  .object({
    domain: z.string(),
    backlinks_spam_score: z.number().nullable().optional(),
    referring_pages: z.number().nullable().optional(),
    rank: z.number().nullable().optional(),
    first_seen: z.string().nullable().optional(),
    lost_date: z.string().nullable().optional(),
    last_seen: z.string().nullable().optional(),
  })
  .passthrough()

/**
 * /v3/backlinks/referring_domains/live
 *
 * Fetches up to `limit` referring domains with their per-domain spam scores.
 * The audit uses this to (a) compute the average spam score, (b) count
 * high-spam domains (>= 50), and (c) surface concrete spammy-domain examples
 * in the PDF — the prompt requires 3-5 specific domain names, not "some
 * low-quality backlinks."
 *
 * Returns a BacklinkReport by combining the summary data + sampled examples.
 */
// ────────────────────────────────────────────────────────────────────────────
// Competitive Analysis tab — indexed-page estimate. Used by /api/comp-analysis/run.

/**
 * site:<domain> SERP query — returns Google's claimed indexed-page count.
 * Approximate; Google's site: count is well-known to be inaccurate, so the
 * Comp Analysis CSV header notes this in a footnote.
 *
 * Defaults to the US country code; callers can pass a city-level Google
 * Ads location code for a city-scoped probe (the SERP endpoint accepts
 * city codes, unlike Labs endpoints).
 */
export async function indexedPageCount(
  domain: string,
  locationCode = DFS_LABS_COUNTRY_CODE_US,
): Promise<number> {
  const target = stripDomain(domain)
  const envelope = await dfsRequest(
    "/v3/serp/google/organic/live/advanced",
    [
      {
        keyword: `site:${target}`,
        location_code: locationCode,
        language_code: DEFAULT_LANGUAGE_CODE,
        depth: 1,
      },
    ],
  )
  const firstTask = envelope.tasks[0]
  const first = firstTask?.result?.[0] as
    | { se_results_count?: number; total_count?: number }
    | undefined
  return first?.se_results_count ?? first?.total_count ?? 0
}

/** Backlinks summary count of referring domains for a target. */
export async function referringDomainCount(domain: string): Promise<number> {
  const summary = await backlinksSummary(domain)
  return summary.referringDomains
}

const bulkBacklinksItemSchema = z
  .object({
    target: z.string(),
    backlinks: z.number().nullable().optional(),
    referring_domains: z.number().nullable().optional(),
    referring_main_domains: z.number().nullable().optional(),
  })
  .passthrough()

/**
 * /v3/backlinks/bulk_backlinks/live — accepts up to 1000 targets per call.
 * Each target can be a domain (`example.com`) or a full URL
 * (`https://example.com/foo`); DFS returns total backlinks and referring
 * domains per target. Used by Comp Analysis to compute per-(domain × city)
 * referring-domain counts scoped to the URLs that rank for the seed
 * keywords in that city.
 */
export async function bulkBacklinksByTarget(
  targets: string[],
): Promise<Map<string, { backlinks: number; referringDomains: number }>> {
  const out = new Map<string, { backlinks: number; referringDomains: number }>()
  if (targets.length === 0) return out
  const unique = Array.from(new Set(targets))
  const chunkSize = 1000
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize)
    const envelope = await dfsRequest("/v3/backlinks/bulk_backlinks/live", [
      { targets: chunk },
    ])
    const firstTask = envelope.tasks[0]
    const result = firstTask?.result?.[0] as
      | { items?: unknown[] }
      | undefined
    const items = result?.items ?? []
    for (const raw of items) {
      const parsed = bulkBacklinksItemSchema.safeParse(raw)
      if (!parsed.success) continue
      out.set(parsed.data.target, {
        backlinks: parsed.data.backlinks ?? 0,
        referringDomains:
          parsed.data.referring_main_domains ??
          parsed.data.referring_domains ??
          0,
      })
    }
  }
  return out
}

export async function referringDomainsWithSpamScore(
  domain: string,
  opts: { limit?: number } = {},
): Promise<BacklinkReport> {
  const target = stripDomain(domain)
  const limit = opts.limit ?? 500

  const [summary, envelope] = await Promise.all([
    backlinksSummary(target),
    dfsRequest("/v3/backlinks/referring_domains/live", [
      {
        target,
        limit,
        backlinks_status_type: "live",
        order_by: ["backlinks_spam_score,desc"],
      },
    ]),
  ])

  const firstTask = envelope.tasks[0]
  const raw = firstTask?.result?.[0] as { items?: unknown[] } | undefined
  const items = raw?.items ?? []

  const samples: ReferringDomainSample[] = []
  for (const rawItem of items) {
    const parsed = referringDomainItemSchema.safeParse(rawItem)
    if (!parsed.success) continue
    samples.push({
      domain: parsed.data.domain,
      spamScore: parsed.data.backlinks_spam_score ?? 0,
      referringPages: parsed.data.referring_pages ?? 0,
      rank: parsed.data.rank ?? 0,
      firstSeen: parsed.data.first_seen ?? undefined,
      lastSeen: parsed.data.last_seen ?? undefined,
    })
  }

  const highSpamSamples = samples
    .filter((s) => s.spamScore >= 50)
    .sort((a, b) => b.spamScore - a.spamScore)
  const highSpamCount = highSpamSamples.length
  const highSpamExamples = highSpamSamples.slice(0, 10)

  const topAuthorityExamples = [...samples]
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 10)

  return {
    domain: target,
    totalBacklinks: summary.totalBacklinks,
    referringDomains: summary.referringDomains,
    averageSpamScore: summary.averageSpamScore,
    highSpamCount,
    highSpamExamples,
    topAuthorityExamples,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Backlink profile pull. Three-call orchestration that captures link
// quality + recency signals separate from the existing
// `referringDomainsWithSpamScore` pass (which orders by spam score desc and
// drives the backlink-risk PDF page). The profile is keyed on domain_rank
// desc and joins per-domain spam scores from the bulk endpoint so the audit
// can compute high-quality / low-quality counts and recent-link velocity.

const profileSummaryItemSchema = z
  .object({
    target: z.string().optional(),
    backlinks: z.number().nullable().optional(),
    referring_domains: z.number().nullable().optional(),
    referring_main_domains: z.number().nullable().optional(),
    backlinks_dofollow: z.number().nullable().optional(),
    /** Distinct anchor count — DataForSEO surfaces this as `anchor`. */
    anchor: z.number().nullable().optional(),
  })
  .passthrough()

const profileReferringDomainItemSchema = z
  .object({
    domain: z.string(),
    rank: z.number().nullable().optional(),
    backlinks: z.number().nullable().optional(),
    first_seen: z.string().nullable().optional(),
    lost_date: z.string().nullable().optional(),
  })
  .passthrough()

const bulkSpamScoreItemSchema = z
  .object({
    target: z.string(),
    spam_score: z.number().nullable().optional(),
  })
  .passthrough()

/**
 * Fetch the full backlink profile for a domain via three DataForSEO calls:
 *   1. /v3/backlinks/summary/live          — totals + dofollow ratio + anchors
 *   2. /v3/backlinks/referring_domains/live — top 100 by domain_rank desc
 *   3. /v3/backlinks/bulk_spam_score/live   — spam score per referring domain
 *
 * Steps 1 + 2 run in parallel; step 3 runs after step 2 because it needs the
 * domain list. Computes the derived counts (high-quality / low-quality /
 * new-link velocity) the audit synthesis uses to decide whether to surface a
 * Backlink Profile section.
 */
export async function backlinkProfile(domain: string): Promise<BacklinkProfile> {
  const target = stripDomain(domain)

  const [summaryEnvelope, domainsEnvelope] = await Promise.all([
    dfsRequest("/v3/backlinks/summary/live", [
      {
        target,
        internal_list_limit: 10,
        backlinks_status_type: "live",
        include_subdomains: true,
      },
    ]),
    dfsRequest("/v3/backlinks/referring_domains/live", [
      {
        target,
        limit: 100,
        backlinks_status_type: "live",
        order_by: ["rank,desc"],
      },
    ]),
  ])

  const summaryRaw = summaryEnvelope.tasks[0]?.result?.[0]
  const summaryParsed = profileSummaryItemSchema.safeParse(summaryRaw ?? {})
  const summary = summaryParsed.success ? summaryParsed.data : {}

  const totalBacklinks = summary.backlinks ?? 0
  const totalReferringDomains =
    summary.referring_main_domains ?? summary.referring_domains ?? 0
  const dofollowRatio =
    totalBacklinks > 0 ? (summary.backlinks_dofollow ?? 0) / totalBacklinks : 0
  const anchorDiversity = summary.anchor ?? 0

  const domainsResult = domainsEnvelope.tasks[0]?.result?.[0] as
    | { items?: unknown[] }
    | undefined
  const rawDomainItems = domainsResult?.items ?? []

  const referring: {
    domain: string
    rank: number
    backlinks: number
    firstSeen?: string
    lost: boolean
  }[] = []
  for (const raw of rawDomainItems) {
    const parsed = profileReferringDomainItemSchema.safeParse(raw)
    if (!parsed.success) continue
    referring.push({
      domain: parsed.data.domain,
      rank: parsed.data.rank ?? 0,
      backlinks: parsed.data.backlinks ?? 0,
      firstSeen: parsed.data.first_seen ?? undefined,
      lost: Boolean(parsed.data.lost_date),
    })
  }

  // Step 3: bulk_spam_score for the referring domains. The endpoint accepts
  // up to 1000 targets per call; with limit=100 above we are well under it.
  const spamMap = new Map<string, number>()
  if (referring.length > 0) {
    const spamEnvelope = await dfsRequest("/v3/backlinks/bulk_spam_score/live", [
      { targets: referring.map((d) => d.domain) },
    ])
    const spamResult = spamEnvelope.tasks[0]?.result?.[0] as
      | { items?: unknown[] }
      | undefined
    const spamItems = spamResult?.items ?? []
    for (const raw of spamItems) {
      const parsed = bulkSpamScoreItemSchema.safeParse(raw)
      if (!parsed.success) continue
      spamMap.set(parsed.data.target, parsed.data.spam_score ?? 0)
    }
  }

  const enriched: BacklinkProfileDomain[] = referring.map((d) => ({
    domain: d.domain,
    domainRank: d.rank,
    backlinks: d.backlinks,
    firstSeen: d.firstSeen,
    lost: d.lost,
    spamScore: spamMap.get(d.domain) ?? 0,
  }))

  // 12-month cutoff for new-link velocity. DataForSEO returns first_seen as
  // an ISO-ish string; Date parsing tolerates both "YYYY-MM-DD" and the full
  // ISO timestamp form. Skip rows where parsing fails.
  const cutoff = new Date()
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1)

  let highQualityDomains = 0
  let lowQualityDomains = 0
  let newLinksLast12Months = 0
  let newLinksLast12MonthsLowQuality = 0
  for (const d of enriched) {
    if (d.spamScore < 30 && d.domainRank > 20) highQualityDomains++
    if (d.spamScore >= 50) lowQualityDomains++
    if (d.firstSeen) {
      const fs = new Date(d.firstSeen)
      if (!Number.isNaN(fs.getTime()) && fs >= cutoff) {
        newLinksLast12Months++
        if (d.spamScore >= 50) newLinksLast12MonthsLowQuality++
      }
    }
  }

  const sampleLowQualityLinks = [...enriched]
    .filter((d) => d.spamScore >= 50)
    .sort((a, b) => b.spamScore - a.spamScore)
    .slice(0, 5)

  return {
    domain: target,
    totalBacklinks,
    totalReferringDomains,
    dofollowRatio,
    anchorDiversity,
    highQualityDomains,
    lowQualityDomains,
    newLinksLast12Months,
    newLinksLast12MonthsLowQuality,
    sampleLowQualityLinks,
    topReferringDomains: enriched,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Backlink growth pattern. Monthly time-series of total backlinks + total
// referring domains for the last ~13 months. Drives the "growth pattern"
// finding in the audit (steady accrual, sudden spikes that often correlate
// with link-buying, or decline that flags lost relationships).

const backlinksTimeseriesItemSchema = z
  .object({
    date: z.string(),
    backlinks: z.number().nullable().optional(),
    referring_domains: z.number().nullable().optional(),
  })
  .passthrough()

/**
 * /v3/backlinks/timeseries_summary/live
 *
 * Returns one item per group_range bucket (default `month`). DataForSEO
 * accepts ISO date strings for `date_from` / `date_to`. We default to a
 * 13-month window so the chart can show the last completed year + the
 * partial current month for trend continuity.
 */
export async function backlinksTimeseriesSummary(
  domain: string,
  opts: {
    dateFrom?: string
    dateTo?: string
    groupRange?: "day" | "week" | "month"
  } = {},
): Promise<BacklinkTimeseriesPoint[]> {
  const target = stripDomain(domain)

  const today = new Date()
  const thirteenMonthsAgo = new Date(today)
  thirteenMonthsAgo.setUTCMonth(thirteenMonthsAgo.getUTCMonth() - 13)

  const params = {
    target,
    date_from: opts.dateFrom ?? thirteenMonthsAgo.toISOString().slice(0, 10),
    date_to: opts.dateTo ?? today.toISOString().slice(0, 10),
    group_range: opts.groupRange ?? "month",
    backlinks_status_type: "live",
  }
  const envelope = await dfsRequest("/v3/backlinks/timeseries_summary/live", [
    params,
  ])
  const result = envelope.tasks[0]?.result?.[0] as
    | { items?: unknown[] }
    | undefined
  const items = result?.items ?? []
  const out: BacklinkTimeseriesPoint[] = []
  for (const raw of items) {
    const parsed = backlinksTimeseriesItemSchema.safeParse(raw)
    if (!parsed.success) continue
    out.push({
      date: parsed.data.date,
      backlinks: parsed.data.backlinks ?? 0,
      referringDomains: parsed.data.referring_domains ?? 0,
    })
  }
  // Sort ascending by date so chart + delta math don't have to.
  out.sort((a, b) => a.date.localeCompare(b.date))
  return out
}

// ────────────────────────────────────────────────────────────────────────────
// Keyword Research workflow — additional wrappers added for the rewritten
// pipeline (see lib/tasks/keyword-research.ts).

/**
 * /v3/dataforseo_labs/google/competitors_domain/live
 *
 * Returns the top N domains that compete with the target on organic SERPs
 * (ranked by intersecting keywords). We only need the domain strings for
 * downstream calls.
 */
export interface CompetitorDomain {
  domain: string
  intersections: number
  organicKeywords: number
  organicTraffic: number
}

const competitorDomainItemSchema = z
  .object({
    domain: z.string(),
    intersections: z.number().nullable().optional(),
    full_domain_metrics: z
      .object({
        organic: z
          .object({
            count: z.number().nullable().optional(),
            etv: z.number().nullable().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough()

export async function competitorsDomain(
  domain: string,
  location: DfsLocation,
  opts: { limit?: number } = {},
): Promise<CompetitorDomain[]> {
  const target = stripDomain(domain)
  const envelope = await dfsRequest(
    "/v3/dataforseo_labs/google/competitors_domain/live",
    [
      {
        target,
        ...locationAndLanguageParams(location),
        limit: opts.limit ?? 5,
      },
    ],
  )
  const out: CompetitorDomain[] = []
  for (const raw of extractLabsItems(envelope)) {
    const parsed = competitorDomainItemSchema.safeParse(raw)
    if (!parsed.success) continue
    const item = parsed.data
    if (!item.domain || stripDomain(item.domain) === target) continue
    out.push({
      domain: item.domain,
      intersections: item.intersections ?? 0,
      organicKeywords: item.full_domain_metrics?.organic?.count ?? 0,
      organicTraffic: item.full_domain_metrics?.organic?.etv ?? 0,
    })
  }
  return out
}

/**
 * /v3/dataforseo_labs/google/keyword_ideas/live (multi-seed variant)
 *
 * The existing `keywordIdeas` wrapper takes a single seed; this variant
 * accepts the full service list in one call as the new keyword research
 * pipeline does.
 */
export async function keywordIdeasMulti(
  keywords: string[],
  location: DfsLocation,
  opts: { limit?: number } = {},
): Promise<KeywordResult[]> {
  if (keywords.length === 0) return []
  const envelope = await dfsRequest(
    "/v3/dataforseo_labs/google/keyword_ideas/live",
    [
      {
        keywords,
        ...locationAndLanguageParams(location),
        limit: opts.limit ?? DEFAULT_LIMIT,
      },
    ],
  )
  return extractLabsItems(envelope).map(normalizeLabsItem)
}

/**
 * /v3/dataforseo_labs/google/related_keywords/live
 *
 * Returns related-search expansions for a single seed. Response items are
 * nested as { keyword_data, related_keywords[] }; we flatten back to a
 * KeywordResult list using the seed's `keyword_data.keyword_info` for
 * volume/CPC/etc. (each related keyword shows up as its own item in the
 * flat result).
 */
const relatedKeywordItemSchema = z
  .object({
    keyword_data: z
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
      })
      .passthrough(),
  })
  .passthrough()

export async function relatedKeywords(
  seed: string,
  location: DfsLocation,
  opts: { limit?: number } = {},
): Promise<KeywordResult[]> {
  const envelope = await dfsRequest(
    "/v3/dataforseo_labs/google/related_keywords/live",
    [
      {
        keyword: seed,
        ...locationAndLanguageParams(location),
        limit: opts.limit ?? 100,
      },
    ],
  )
  const out: KeywordResult[] = []
  for (const raw of extractLabsItems(envelope)) {
    const parsed = relatedKeywordItemSchema.safeParse(raw)
    if (!parsed.success) continue
    const kd = parsed.data.keyword_data
    out.push({
      keyword: kd.keyword,
      search_volume: kd.keyword_info?.search_volume ?? undefined,
      cpc: kd.keyword_info?.cpc ?? undefined,
      competition: kd.keyword_info?.competition ?? undefined,
      competition_level: toCompetitionLevel(kd.keyword_info?.competition_level),
      keyword_difficulty: kd.keyword_properties?.keyword_difficulty ?? undefined,
    })
  }
  return out
}

/**
 * /v3/dataforseo_labs/google/search_intent/live
 *
 * Classifies each keyword's primary intent (informational / navigational /
 * commercial / transactional). DFS returns the label under
 * `keyword_intent.label`.
 */
export type SearchIntent =
  | "informational"
  | "navigational"
  | "commercial"
  | "transactional"

const searchIntentItemSchema = z
  .object({
    keyword: z.string(),
    keyword_intent: z
      .object({
        label: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough()

function toIntent(raw: string | null | undefined): SearchIntent | undefined {
  if (!raw) return undefined
  const v = raw.toLowerCase()
  if (
    v === "informational" ||
    v === "navigational" ||
    v === "commercial" ||
    v === "transactional"
  ) {
    return v
  }
  return undefined
}

export async function searchIntent(
  keywords: string[],
  location: DfsLocation,
): Promise<Map<string, SearchIntent>> {
  const out = new Map<string, SearchIntent>()
  if (keywords.length === 0) return out
  // The endpoint accepts up to 1000 keywords per call.
  const CHUNK = 1000
  for (let i = 0; i < keywords.length; i += CHUNK) {
    const chunk = keywords.slice(i, i + CHUNK)
    const envelope = await dfsRequest(
      "/v3/dataforseo_labs/google/search_intent/live",
      [
        {
          keywords: chunk,
          ...locationAndLanguageParams(location),
        },
      ],
    )
    for (const raw of extractLabsItems(envelope)) {
      const parsed = searchIntentItemSchema.safeParse(raw)
      if (!parsed.success) continue
      const intent = toIntent(parsed.data.keyword_intent?.label)
      if (intent) out.set(parsed.data.keyword.toLowerCase(), intent)
    }
  }
  return out
}

// ────────────────────────────────────────────────────────────────────────────
// SERP standard-queue task lifecycle.
//
// Standard queue (vs. /live/advanced) is much cheaper per task but async:
// you POST a batch of tasks, poll `tasks_ready` until they finish, then
// GET each by id. Used by Phase 3 of keyword-research to probe city-level
// rankings for ~50–200 (keyword × city) pairs without paying live-mode
// rates.

export interface SerpTaskHandle {
  id: string
  keyword: string
  locationName: string
}

const taskPostItemSchema = z
  .object({
    id: z.string(),
    status_code: z.number(),
    status_message: z.string(),
    data: z
      .object({
        keyword: z.string().optional(),
        location_name: z.string().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough()

export interface SerpTaskRequest {
  keyword: string
  locationName: string
  depth?: number
}

/**
 * /v3/serp/google/organic/task_post
 *
 * Submits up to 100 SERP tasks per call. Returns one handle per submitted
 * task (with the DFS-issued task id) so the caller can correlate poll
 * results back to (keyword, city). Failed-on-submit tasks are skipped with
 * a warning; the returned array is shorter than the input in that case.
 */
export async function serpTaskPost(
  tasks: SerpTaskRequest[],
): Promise<SerpTaskHandle[]> {
  if (tasks.length === 0) return []
  const handles: SerpTaskHandle[] = []
  // DFS accepts up to 100 tasks per task_post call.
  const CHUNK = 100
  for (let i = 0; i < tasks.length; i += CHUNK) {
    const chunk = tasks.slice(i, i + CHUNK)
    const body = chunk.map((t) => ({
      keyword: t.keyword,
      location_name: t.locationName,
      language_code: DEFAULT_LANGUAGE_CODE,
      depth: t.depth ?? 20,
    }))
    const envelope = await dfsRequest("/v3/serp/google/organic/task_post", body)
    for (let j = 0; j < envelope.tasks.length; j++) {
      const taskRaw = envelope.tasks[j]
      const parsed = taskPostItemSchema.safeParse(taskRaw)
      if (!parsed.success) continue
      // Per-task posting status: 20100 = task created; anything else means
      // the submission itself failed for that single keyword. Skip silently
      // and let the caller treat missing results as "not probed".
      if (parsed.data.status_code !== 20100) {
        console.warn(
          `[dataforseo] task_post item failed status=${parsed.data.status_code} message=${parsed.data.status_message}`,
        )
        continue
      }
      const original = chunk[j]
      handles.push({
        id: parsed.data.id,
        keyword: parsed.data.data?.keyword ?? original?.keyword ?? "",
        locationName:
          parsed.data.data?.location_name ?? original?.locationName ?? "",
      })
    }
  }
  return handles
}

const tasksReadyItemSchema = z
  .object({ id: z.string() })
  .passthrough()

/**
 * /v3/serp/google/organic/tasks_ready
 *
 * Returns ids of every task that's finished and is awaiting a GET. This is
 * a global queue scoped to the DFS account — the caller must intersect
 * with the handles it submitted.
 */
export async function serpTasksReady(): Promise<string[]> {
  const envelope = await dfsRequest(
    "/v3/serp/google/organic/tasks_ready",
    [],
  )
  const ids: string[] = []
  for (const taskRaw of envelope.tasks) {
    const result = (taskRaw as { result?: unknown[] }).result ?? []
    for (const item of result) {
      const parsed = tasksReadyItemSchema.safeParse(item)
      if (parsed.success) ids.push(parsed.data.id)
    }
  }
  return ids
}

const serpTaskItemSchema = z
  .object({
    type: z.string().optional(),
    rank_group: z.number().nullable().optional(),
    rank_absolute: z.number().nullable().optional(),
    domain: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
  })
  .passthrough()

export interface SerpOrganicResult {
  position: number
  domain: string
  url: string
  title: string
}

export interface SerpTaskResult {
  taskId: string
  keyword: string
  locationName: string
  itemTypes: string[]
  organic: SerpOrganicResult[]
}

/**
 * /v3/serp/google/organic/task_get/advanced/{id}
 *
 * Fetches the SERP for a single completed task. We pull every item but
 * keep only the organic results (with rank + domain + url) and a flat list
 * of every item-type seen (useful for surfacing SERP features like
 * `local_pack`, `featured_snippet`, `people_also_ask`).
 */
export async function serpTaskGet(taskId: string): Promise<SerpTaskResult> {
  const envelope = await dfsRequest<DfsEnvelope>(
    `/v3/serp/google/organic/task_get/advanced/${encodeURIComponent(taskId)}`,
    {},
  )
  const firstTask = envelope.tasks[0]
  const result = (firstTask?.result ?? [])[0] as
    | {
        keyword?: string
        location_name?: string
        items?: unknown[]
      }
    | undefined
  const items = result?.items ?? []
  const itemTypes = new Set<string>()
  const organic: SerpOrganicResult[] = []
  for (const raw of items) {
    const parsed = serpTaskItemSchema.safeParse(raw)
    if (!parsed.success) continue
    const it = parsed.data
    if (it.type) itemTypes.add(it.type)
    if (it.type === "organic") {
      const position = it.rank_absolute ?? it.rank_group ?? 0
      if (!position) continue
      organic.push({
        position,
        domain: it.domain ?? "",
        url: it.url ?? "",
        title: it.title ?? "",
      })
    }
  }
  return {
    taskId,
    keyword: result?.keyword ?? "",
    locationName: result?.location_name ?? "",
    itemTypes: Array.from(itemTypes),
    organic: organic.sort((a, b) => a.position - b.position),
  }
}
