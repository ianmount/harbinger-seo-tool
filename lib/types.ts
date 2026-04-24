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
  /**
   * GA4 property identifier from Airtable. Stored as either a bare numeric ID
   * ("123456789") or the full resource name ("properties/123456789"). Callers
   * should pass the raw value through `normalizePropertyId` in `lib/ga4.ts`
   * before sending it to the GA4 API.
   */
  ga4PropertyId?: string
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
 * DataForSEO location param. Prefer `{ name }` for "live" endpoints because
 * they accept `location_name` directly without a code lookup. `{ code }` is
 * supported for when a caller has already resolved to a specific location id.
 */
export type DfsLocation = { code: number } | { name: string }

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

/**
 * GA4 types. GA4 integration is optional per partner; code paths that surface
 * GA4 data must handle a missing `ga4PropertyId` gracefully.
 */

/** A GA4 property accessible to the authed Google account. */
export interface GA4PropertyInfo {
  /** Full resource name, e.g. "properties/123456789". */
  propertyId: string
  displayName: string
  /** Primary web stream URL if the caller resolved it. Often unset. */
  websiteUrl?: string
}

export interface GA4LandingPage {
  landingPage: string
  sessions: number
  conversions: number
  /** 0–1 fraction. 0 when sessions is 0. */
  conversionRate: number
}

export interface GA4TrafficSource {
  source: string
  medium: string
  sessions: number
  conversions: number
}

export interface GA4SeoReport {
  /** Normalized "properties/X" form. */
  propertyId: string
  dateRange: { startDate: string; endDate: string }
  sessions: number
  users: number
  conversions: number
  /**
   * False when no conversion events fired across any dimension in the range.
   * Consumers can use this to show "conversions not configured" messaging.
   */
  conversionsConfigured: boolean
  topLandingPages: GA4LandingPage[]
  trafficSources: GA4TrafficSource[]
  /** Top landing pages filtered to sessionDefaultChannelGroup = "Organic Search". */
  organicOnly: GA4LandingPage[]
}

/**
 * Per-page conversion signal for keyword scoring. Sorted by conversions desc
 * and filtered to pages with > 0 conversions (empty array when conversions
 * are not configured).
 */
export interface GA4PageConversion {
  landingPage: string
  conversions: number
  conversionRate: number
}
