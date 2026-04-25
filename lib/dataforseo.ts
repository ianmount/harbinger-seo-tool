import "server-only"
import { z } from "zod"
import { recordDataForSEOCost } from "@/lib/audit-cost"
import { requireEnv } from "@/lib/env"
import type {
  BacklinkReport,
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

  // Retry up to 3 times on 429 with exponential backoff + jitter so a
  // burst of parallel calls doesn't all bunch up at the same retry instant.
  let response = await fetch(url, init)
  for (let attempt = 0; attempt < 3 && response.status === 429; attempt++) {
    const backoffMs =
      RATE_LIMIT_RETRY_MS * 2 ** attempt + Math.floor(Math.random() * 500)
    await new Promise((r) => setTimeout(r, backoffMs))
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
  opts: { limit?: number } = {},
): Promise<RankedKeyword[]> {
  const target = stripDomain(domain)
  const envelope = await dfsRequest(
    "/v3/dataforseo_labs/google/ranked_keywords/live",
    [
      {
        target,
        ...locationAndLanguageParams(location),
        limit: opts.limit ?? 100,
        order_by: ["ranked_serp_element.serp_item.etv,desc"],
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

const serpItemSchema = z
  .object({
    type: z.string().optional(),
    domain: z.string().nullable().optional(),
    rank_absolute: z.number().nullable().optional(),
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
// Competitive Analysis tab — ranked-keyword position counts + indexed-page
// estimate. Used by /api/comp-analysis/run.

const rankedKeywordPositionItemSchema = z
  .object({
    ranked_serp_element: z
      .object({
        serp_item: z
          .object({
            rank_absolute: z.number().nullable().optional(),
            rank_group: z.number().nullable().optional(),
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

export interface RankedPositionCounts {
  top3: number
  top10: number
  top20: number
  top100: number
  /** Total keywords sampled (capped at MAX). */
  sampled: number
  /** True when the cap was hit and counts are an underestimate. */
  truncated: boolean
}

const RANKED_PAGE_SIZE = 1000
const RANKED_MAX_KEYWORDS = 10_000

/**
 * Pull the full set of keywords a domain ranks for in a given location and
 * count how many fall into the Top 3 / 10 / 20 / 100 buckets.
 *
 * Pages until total_count is reached, capped at RANKED_MAX_KEYWORDS to avoid
 * runaway calls on enormous domains. Logs a warning when capped — the
 * resulting counts are then a lower bound. DataForSEO Labs rejects city-level
 * location names with status 40501; pass state-level (e.g. "Florida,United
 * States") or a country code (2840) for reliable results.
 */
export async function rankedKeywordPositionCounts(
  domain: string,
  location: DfsLocation,
): Promise<RankedPositionCounts> {
  const target = stripDomain(domain)
  const counts = { top3: 0, top10: 0, top20: 0, top100: 0 }
  let sampled = 0
  let offset = 0
  let truncated = false

  while (sampled < RANKED_MAX_KEYWORDS) {
    const limit = Math.min(RANKED_PAGE_SIZE, RANKED_MAX_KEYWORDS - sampled)
    const envelope = await dfsRequest(
      "/v3/dataforseo_labs/google/ranked_keywords/live",
      [
        {
          target,
          ...locationAndLanguageParams(location),
          limit,
          offset,
          ignore_synonyms: true,
          load_rank_absolute: true,
        },
      ],
    )
    const firstTask = envelope.tasks[0]
    const result = firstTask?.result?.[0] as
      | { items?: unknown[]; total_count?: number }
      | undefined
    const items = result?.items ?? []
    if (items.length === 0) break

    for (const raw of items) {
      const parsed = rankedKeywordPositionItemSchema.safeParse(raw)
      if (!parsed.success) continue
      const serp = parsed.data.ranked_serp_element?.serp_item
      const position = serp?.rank_absolute ?? serp?.rank_group ?? 0
      if (!position) continue
      sampled++
      if (position <= 3) counts.top3++
      if (position <= 10) counts.top10++
      if (position <= 20) counts.top20++
      if (position <= 100) counts.top100++
    }

    const total = result?.total_count ?? sampled
    if (sampled >= total) break
    if (sampled >= RANKED_MAX_KEYWORDS) {
      truncated = true
      console.warn(
        `[dataforseo] rankedKeywordPositionCounts capped at ${RANKED_MAX_KEYWORDS} for ${target} (total=${total})`,
      )
      break
    }
    offset += items.length
    if (items.length < limit) break
  }

  return { ...counts, sampled, truncated }
}

/**
 * site:<domain> SERP query — returns Google's claimed indexed-page count.
 * Approximate; Google's site: count is well-known to be inaccurate, so the
 * Comp Analysis CSV header notes this in a footnote.
 */
export async function indexedPageCount(domain: string): Promise<number> {
  const target = stripDomain(domain)
  const envelope = await dfsRequest(
    "/v3/serp/google/organic/live/advanced",
    [
      {
        keyword: `site:${target}`,
        location_code: DFS_LABS_COUNTRY_CODE_US,
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
