/**
 * Shared TypeScript types.
 *
 * Partner mirrors the Airtable schema as agreed with the user on 2026-04-23:
 *   - "Profile"             → name (required; trailing " | Profile" stripped)
 *   - "Services"            → services (required)
 *   - "Service Areas"       → serviceAreas (required)
 *   - "Website"             → website (required)
 *   - "Partner Goals"       → partnerGoals (optional)
 *   - "Target Audience"     → targetAudience (optional)
 *   - "Content Marketing"   → contentMarketing (optional)
 *   - "Industry Knowledge"  → industryKnowledge (optional)
 *
 * Airtable does not yet have a dedicated GSC siteUrl field, so the GSC client
 * derives it from `website` (URL-prefix format, e.g. "https://example.com/").
 * When a dedicated field is added, extend Partner with `gscSiteUrl?: string`.
 *
 * `unfilledContext` lists property names whose source Airtable field still
 * contains the record-template boilerplate (text starting with "**Template**").
 * UIs that feed partner context to Claude should surface a warning so users
 * know to fill those fields in Airtable before running strategy/content.
 */
export type PartnerContextField =
  | "services"
  | "serviceAreas"
  | "partnerGoals"
  | "targetAudience"
  | "contentMarketing"
  | "industryKnowledge"

export interface Partner {
  id: string
  name: string
  services: string
  serviceAreas: string
  website: string
  partnerGoals?: string
  targetAudience?: string
  contentMarketing?: string
  industryKnowledge?: string
  unfilledContext?: PartnerContextField[]
}

/**
 * Normalized keyword result across DataForSEO endpoints. Fields use the raw
 * API naming (snake_case) so the mapping from DataForSEO responses is direct.
 *
 * - `search_volume`, `cpc`, `competition`, `competition_level`: populated by
 *   keyword_ideas, keyword_suggestions, and search_volume endpoints.
 * - `keyword_difficulty` (0–100): populated by bulk_keyword_difficulty, and
 *   opportunistically by keyword_ideas/suggestions when DataForSEO includes
 *   it under `keyword_properties`.
 * - `competition` is normalized to the 0–1 range. The Google Ads endpoint
 *   returns a 0–100 index; we divide by 100.
 * - `competition_level` is the string bucket DataForSEO returns
 *   ("HIGH" / "MEDIUM" / "LOW"). Always uppercase when present.
 */
export type CompetitionLevel = "HIGH" | "MEDIUM" | "LOW"

export interface KeywordResult {
  keyword: string
  search_volume?: number
  cpc?: number
  competition?: number
  competition_level?: CompetitionLevel
  keyword_difficulty?: number
}

/**
 * Output of the Claude clustering/scoring step. Extends KeywordResult with
 * Claude's assigned cluster, fit score, intent classification, and
 * target/monitor/skip recommendation.
 */
export type KeywordIntent =
  | "informational"
  | "commercial"
  | "transactional"
  | "navigational"

export type KeywordRecommendation = "target" | "monitor" | "skip"

export interface ScoredKeyword extends KeywordResult {
  cluster: string
  fitScore: number
  intent: KeywordIntent
  recommendation: KeywordRecommendation
}

export interface KeywordCluster {
  name: string
  keywords: ScoredKeyword[]
}

/**
 * DataForSEO location param. Prefer `{ code }` for Labs endpoints — their
 * `location_name` matching is flaky (even "Atlanta,Georgia,United States"
 * can get rejected with status 40501). Codes come from DFS's own location
 * taxonomy and are always accepted when valid.
 */
export type DfsLocation = { code: number } | { name: string }

/** One row from DataForSEO's Labs location taxonomy. */
export interface DfsLabsLocation {
  location_code: number
  location_name: string
  location_code_parent: number | null
  country_iso_code: string | null
  location_type: string
}

/** Google Search Console property the authed account has access to. */
export interface GSCSiteInfo {
  siteUrl: string
  permissionLevel: string
}

/** Row from searchanalytics.query with dimensions ['query', 'page']. */
export interface GSCQueryRow {
  query: string
  page: string
  clicks: number
  impressions: number
  ctr: number
  position: number
}

/** Row from searchanalytics.query with dimensions ['query']. */
export interface GSCTopQueryRow {
  query: string
  clicks: number
  impressions: number
  ctr: number
  position: number
}

/** Row from searchanalytics.query with dimensions ['page']. */
export interface GSCTopPageRow {
  page: string
  clicks: number
  impressions: number
  ctr: number
  position: number
}

/** Row from searchanalytics.query with dimensions ['date']. */
export interface GSCDailyRow {
  date: string
  clicks: number
  impressions: number
  ctr: number
  position: number
}
