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
  /**
   * True when the keyword's best-matching GSC landing page is one of the
   * partner's high-converting pages in GA4 (see lib/ga4.ts). Populated only
   * when the partner has a GA4 property configured; undefined otherwise.
   * Used by Claude as a modest fit-score boost and surfaced in the results
   * table so the engineer can see why a keyword scored high.
   */
  pageConversionSignal?: boolean
  /**
   * The GSC landing page used to compute pageConversionSignal — useful for
   * debugging why a signal did or didn't fire. Path-only (no scheme/host).
   */
  landingPage?: string
  /**
   * Current organic SERP position (1-indexed) for the configured domain
   * in the location this keyword was scored against. Populated post-Claude
   * by probing DataForSEO `/v3/serp/google/organic/live/advanced` per
   * (keyword, location). Undefined when the domain is not in the top
   * `depth` (default 100) organic results, when no domain was provided,
   * or when the SERP probe failed for that keyword.
   */
  currentRanking?: number
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

/**
 * One sample URL inspected via the GSC URL Inspection API. Fields are the
 * subset of `inspectionResult.indexStatusResult` we use to triage whether a
 * sitemap URL is genuinely missing from Google's index. `coverageState` is
 * the human-readable string Google returns ("Submitted and indexed", "URL is
 * unknown to Google", "Crawled - currently not indexed", etc.).
 *
 * `error` is set when the inspection call itself failed for that URL — the
 * audit pipeline keeps the row so the user sees the gap instead of silently
 * dropping inspection failures.
 */
export interface InspectedUrl {
  url: string
  coverageState: string | null
  lastCrawlTime: string | null
  pageFetchState: string | null
  /** "PASS" | "PARTIAL" | "FAIL" | "NEUTRAL" | "VERDICT_UNSPECIFIED" or null. */
  verdict: string | null
  error?: string
}

/**
 * Indexation-coverage proxy derived from sitemap + GSC search analytics.
 *
 * GSC's full Coverage report is not exposed via API, so we approximate:
 *   1. `sitemapUrls` are what SHOULD be indexed (caller-supplied from crawl).
 *   2. `indexedUrls` are sitemap URLs that received any impressions in the
 *      90-day window — they're at minimum being seen by Google.
 *   3. `probablyNotIndexed` = sitemapUrls − indexedUrls (set difference on
 *      normalized URLs — see `normalizeUrlForIndexComparison` in lib/gsc.ts).
 *   4. `inspectedSample` is up to 10 URLs from `probablyNotIndexed`, run
 *      through urlInspection.index.inspect() to confirm the coverage state.
 *
 * URL Inspection API has a 2,000-call/day quota per property; capping the
 * sample at 10 keeps audits well clear of that limit.
 */
export interface IndexCoverageReport {
  siteUrl: string
  /** 90-day window the comparison was run against. */
  dateRange: { startDate: string; endDate: string }
  /** Total sitemap URLs the caller supplied (pre-normalization). */
  sitemapCount: number
  /** Sitemap URLs that received >=1 impression in the window. */
  indexedUrls: string[]
  /** Sitemap URLs that received zero impressions in the window. */
  probablyNotIndexed: string[]
  /** Up to 10 inspected sample URLs from `probablyNotIndexed`. */
  inspectedSample: InspectedUrl[]
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

/**
 * One referring domain pulled from DataForSEO's backlinks/referring_domains
 * endpoint, flattened to the fields the backlinks tab actually uses. `rank`
 * is DataForSEO's 0–1000 authority metric (higher = stronger domain);
 * `spamScore` is 0–100 (higher = more likely spammy). `referringTo` is the
 * competitor target whose referring list surfaced this domain — so the user
 * can click through and see the actual link context.
 *
 * Distinct from `ReferringDomainSample` (see Audit tab types below): that
 * type is produced by the prospect audit's backlink pass and tracks
 * `referringPages` + `lastSeen` rather than the sourcing competitor.
 */
export interface ReferringDomain {
  domain: string
  rank: number
  backlinks: number
  spamScore: number
  firstSeen?: string
  /** The competitor target we fetched referrers for. */
  referringTo: string
}

/**
 * Backlinks tab prospect categorized by Claude. Adds a category + outreach
 * angle to the raw ReferringDomain so the user can triage prospects in the
 * results table.
 *
 * Categories:
 *  - citation        — directories / listing sites (YellowPages, BBB, etc.)
 *  - resource_page   — curated link lists ("Top 10 Plumbers in Tulsa")
 *  - editorial       — publications that run articles (local news, blogs)
 *  - supplier        — businesses whose partner/vendor page could mention us
 *  - other           — anything Claude can't confidently categorize
 */
export type ProspectCategory =
  | "citation"
  | "resource_page"
  | "editorial"
  | "supplier"
  | "other"

export type OutreachPriority = "high" | "medium" | "low"

export interface CategorizedProspect extends ReferringDomain {
  category: ProspectCategory
  angle: string
  reasoning: string
  outreachPriority: OutreachPriority
}

/**
 * One message in a 3-email outreach sequence. `sendAfterDays` is days from
 * the initial send (0 for the first email, 3–7 for follow-ups).
 */
export interface OutreachEmail {
  subject: string
  body: string
  sendAfterDays: number
}

// ────────────────────────────────────────────────────────────────────────────
// Audit tab types.
//
// A Prospect is the pre-sales counterpart to Partner: an in-memory record
// representing a potential partner the MD is pitching. Unlike Partner it is
// NOT persisted to Airtable — it lives only for the duration of one audit
// request. Fields intentionally mirror the subset of Partner the audit
// pipeline needs, but naming makes the distinction clear at call sites.
//
// The audit pipeline produces a series of typed intermediate results
// (CrawlReport → CompetitiveReport → BacklinkReport) that feed the Claude
// synthesis step and ultimately the PDF. Each step's output is a serializable
// object so the Next route handlers can return them unchanged to the client,
// which re-posts the aggregate to the Claude route.

/** A single city/state the prospect wants to rank in. */
export interface TargetMarket {
  city: string
  state: string
}

/**
 * The prospect being audited. Entered manually by the MD on the Audit tab —
 * not looked up from Airtable.
 *
 * `gscSiteUrl` and `ga4PropertyId` are optional: when set, the audit pulls
 * first-party GSC/GA4 data (the SEO Ops Google account must have access).
 * When unset, the audit falls back to DataForSEO-only data and the PDF is
 * clearly marked as a "limited audit" so the MD sees the data gap.
 */
export interface Prospect {
  /** Bare domain ("example.com") — no scheme, no trailing slash. */
  domain: string
  targetMarkets: TargetMarket[]
  /** 0–5 competitor domains. Empty array means "have Claude propose them." */
  competitors: string[]
  gscSiteUrl?: string
  ga4PropertyId?: string
  /** Used in the PDF cover / Claude synthesis to personalize. */
  contactName?: string
}

// ── Crawler outputs ────────────────────────────────────────────────────────

/**
 * Crawl mode the audit pipeline runs in.
 *
 *   - `"full"`    — crawl every URL discovered in the sitemap (subject to the
 *                   crawler's safety ceiling). Default for production audits.
 *   - `"sample"`  — cap at 50 prioritized URLs. Fast-path for testing.
 */
export type CrawlMode = "full" | "sample"

/** Per-URL result from the cheerio crawl. */
export interface CrawledPage {
  url: string
  finalUrl: string
  status: number
  /** True if the HTTP chain included at least one redirect. */
  redirected: boolean
  /**
   * Ordered list of intermediate URLs traversed before `finalUrl`. Empty
   * when the request returned 200 directly. The first entry is the URL the
   * crawler hit; the last entry is the final URL (same as `finalUrl`).
   */
  redirectChain: string[]
  title: string | null
  metaDescription: string | null
  metaRobots: string | null
  canonical: string | null
  /** Headings in document order. */
  h1s: string[]
  h2s: string[]
  h3s: string[]
  /** Distinct @type values pulled from JSON-LD blocks on the page. */
  schemaTypes: string[]
  /** Raw parsed JSON-LD objects, kept verbatim for downstream analysis. */
  schemaBlocks: unknown[]
  /** <img> tags total vs. ones with non-empty alt. */
  imagesTotal: number
  imagesWithAlt: number
  /** Resolved absolute URLs for every same-domain `<a href>` on the page. */
  internalLinksOut: string[]
  wordCount: number
  /** Wall-clock time spent fetching + parsing this URL, in milliseconds. */
  loadTimeMs: number
  /**
   * True when the page appears to be a client-rendered SPA shell (empty
   * body text + React/Next/Vue root div). Surfaced as an audit finding
   * because Googlebot's initial render may see nothing.
   */
  spaShellDetected: boolean
  /** Populated when the fetch errored (non-HTTP failure, parse failure). */
  error?: string
}

/**
 * Aggregate findings across the whole crawl. Groups are keyed by the
 * duplicate value (title / description string) and list the offending URLs.
 *
 * Named `CrawlResults` so synthesis-layer code reads naturally
 * (`crawl: CrawlResults`); `CrawlReport` is kept as a backwards-compat
 * alias for existing call sites.
 */
export interface CrawlResults {
  domain: string
  /** Crawl mode that produced this report. */
  mode: CrawlMode
  sitemapUrls: string[]
  /** URLs actually fetched (may be a subset of sitemap if capped). */
  crawledCount: number
  /** Max pages the crawl was allowed to fetch. */
  maxPages: number
  pages: CrawledPage[]
  nonOkPages: { url: string; status: number }[]
  duplicateTitles: { title: string; urls: string[] }[]
  duplicateDescriptions: { description: string; urls: string[] }[]
  missingCanonicals: string[]
  missingTitles: string[]
  missingDescriptions: string[]
  thinContentPages: { url: string; wordCount: number }[]
  spaShellPages: string[]
  /** Unique schema.org types seen across the site. */
  schemaTypesPresent: string[]
  /** Standard LocalBusiness / Service / Review schemas missing everywhere. */
  schemaTypesRecommended: string[]
  imageAltCoveragePercent: number
  crawlDurationMs: number
  /**
   * Status code → page count. Includes 0 for pages that failed to fetch
   * before getting a status (timeouts, DNS errors, etc.).
   */
  statusCodeDistribution: Record<string, number>
  /**
   * Count of OK pages with no JSON-LD beyond Article / Person / ImageObject —
   * i.e. nothing that helps a local business rank (LocalBusiness, Service,
   * BreadcrumbList, FAQPage, Review, Organization).
   */
  pagesMissingMeaningfulSchema: number
  /** robots.txt Crawl-delay value applied (seconds). 0 when none was set. */
  crawlDelaySec: number
}

/** Backwards-compatible alias. Prefer `CrawlResults` in new code. */
export type CrawlReport = CrawlResults

// ── DataForSEO extended types for audit ────────────────────────────────────

export interface DomainRankOverview {
  domain: string
  locationCode: number
  locationName: string
  organicKeywords: number
  organicTraffic: number
  /** Estimated monthly traffic cost (USD). */
  organicTrafficCost: number
  paidKeywords: number
  paidTraffic: number
}

/** One row of competitive comparison: domain × target market. */
export interface CompetitiveRow {
  domain: string
  isProspect: boolean
  markets: {
    city: string
    state: string
    locationCode: number
    organicKeywords: number
    organicTraffic: number
    organicTrafficCost: number
    /** Top 3 ranked keywords for this domain in this market, by traffic. */
    topKeywords: { keyword: string; position: number; searchVolume: number }[]
  }[]
}

export interface CompetitiveReport {
  prospectDomain: string
  markets: TargetMarket[]
  rows: CompetitiveRow[]
  /** True when Claude auto-suggested competitors (MD left the field blank). */
  competitorsAutoSuggested: boolean
}

export interface ReferringDomainSample {
  domain: string
  /** DataForSEO backlink_spam_score 0–100; higher = spammier. */
  spamScore: number
  referringPages: number
  rank: number
  firstSeen?: string
  lastSeen?: string
}

export interface BacklinkReport {
  domain: string
  totalBacklinks: number
  referringDomains: number
  /** Average spam score across the sample. */
  averageSpamScore: number
  /** Count of referring domains with spam_score >= 50. */
  highSpamCount: number
  /** Up to 10 concrete spammy domain examples sorted by spam score desc. */
  highSpamExamples: ReferringDomainSample[]
  /** Up to 10 highest-authority referring domains for context. */
  topAuthorityExamples: ReferringDomainSample[]
}

/**
 * One referring domain row in the backlink-profile pull. Distinct from
 * `ReferringDomainSample` (used by `BacklinkReport`): this row carries the
 * spam score joined from /v3/backlinks/bulk_spam_score/live and a `lost`
 * flag from /v3/backlinks/referring_domains/live so the audit can quantify
 * recent link velocity (newly-acquired vs lost) alongside quality.
 */
export interface BacklinkProfileDomain {
  domain: string
  /** DataForSEO domain rank (0–1000; higher = stronger). */
  domainRank: number
  /** Backlink count from this domain. */
  backlinks: number
  /** ISO date the link was first observed. */
  firstSeen?: string
  /** True when DataForSEO marked the link as lost (lost_date present). */
  lost: boolean
  /** Spam score 0–100 (higher = spammier). */
  spamScore: number
}

/**
 * Output of `backlinkProfile()` — orchestrates a three-call pull from
 * DataForSEO (summary + referring_domains + bulk_spam_score) and computes
 * the derived metrics the audit uses to flag link-quality risk. Distinct
 * from `BacklinkReport`, which is the spammy-domain example list rendered
 * in the existing Backlink Risk PDF page.
 */
export interface BacklinkProfile {
  domain: string
  totalBacklinks: number
  totalReferringDomains: number
  /** Fraction of backlinks marked dofollow (0–1). 0 when total is 0. */
  dofollowRatio: number
  /** Count of distinct anchor texts on the domain (anchor-diversity proxy). */
  anchorDiversity: number
  /** Referring domains with spam_score < 30 AND domain_rank > 20. */
  highQualityDomains: number
  /** Referring domains with spam_score >= 50. */
  lowQualityDomains: number
  /** Referring domains first seen in the last 12 months. */
  newLinksLast12Months: number
  /** Subset of newLinksLast12Months with spam_score >= 50. */
  newLinksLast12MonthsLowQuality: number
  /** Top 5 worst (high-spam) referring domains for the report. */
  sampleLowQualityLinks: BacklinkProfileDomain[]
  /** Up to 100 referring domains by domain_rank desc, with spam scores joined. */
  topReferringDomains: BacklinkProfileDomain[]
}

// ── GSC / GA4 slices the audit passes to Claude ───────────────────────────

/**
 * GSC slice for the audit. Holds two windows:
 *   - `longRange`  — up to 16 months (the GSC retention max), used for
 *                    position distribution, page concentration, mega-impression
 *                    hubs, topic clustering. The rich analyses live here.
 *   - `recent`     — last 90 days, used to compute the partner's OWN observed
 *                    CTR benchmarks at top-3 by impression tier. This is the
 *                    calibration baseline for every uplift estimate Claude
 *                    produces — we do NOT use industry CTR averages.
 *
 * Plus the derived analyses that we compute server-side and pass to Claude
 * pre-chewed, because doing arithmetic on 25,000-row exports inside a Claude
 * prompt is unreliable.
 */
export interface AuditGscSlice {
  siteUrl: string
  longRange: AuditGscWindow
  recent: AuditGscWindow
  /** Derived analyses (server-side computed) — see lib/audit-analyses.ts. */
  analyses: AuditGscAnalyses
}

export interface AuditGscWindow {
  dateRange: { startDate: string; endDate: string }
  totalClicks: number
  totalImpressions: number
  topQueries: GSCTopQueryRow[]
  topPages: GSCTopPageRow[]
}

/**
 * One band of the position-distribution table.
 *
 * `band` is a human label like "1–3" or "11–20". Bands are inclusive at both
 * ends. Counts are rolled up across the entire long-range query export, so
 * an impression tier value here represents 16-month cumulative impressions.
 */
export interface PositionBand {
  band: string
  positionMin: number
  positionMax: number
  queryCount: number
  clicks: number
  impressions: number
  /** Aggregate CTR across the whole band: clicks / impressions. */
  ctr: number
}

/**
 * Observed-CTR benchmark for the partner's OWN queries at top-3 positions,
 * segmented by impression tier. These are the calibration values that drive
 * every uplift estimate downstream — derived from the 90-day recent window
 * (positions 1–3, non-brand queries only when we can detect the brand).
 *
 * `tier` is a label like "<100" or "1K–10K". When `queryCount` is below
 * `minSampleSize` the tier is flagged as low-confidence and the audit must
 * fall back to a conservative default rather than reporting a noisy number.
 */
export interface ObservedCtrTier {
  tier: string
  impressionMin: number
  impressionMax: number | null
  queryCount: number
  /** Mean CTR across queries in this tier. */
  meanCtr: number
  /** Median CTR — used in commentary because it's robust to outliers. */
  medianCtr: number
  /** True when queryCount is too low to trust (< 5). */
  lowConfidence: boolean
}

/**
 * One quick-win query: currently sitting at positions 4–10, with enough
 * impressions to make a top-3 move worth the work. Uplift is calibrated
 * against the partner's own observed CTR for the matched impression tier.
 */
export interface QuickWinQuery {
  query: string
  page: string | null
  currentPosition: number
  currentClicks: number
  currentImpressions: number
  currentCtr: number
  /** Tier label from ObservedCtrTier, used to look up calibrated CTR. */
  matchedTier: string
  /** Calibrated CTR drawn from the partner's own top-3 data for the tier. */
  projectedTopThreeCtr: number
  /** Annualized clicks at projectedTopThreeCtr × annualized impressions. */
  projectedAnnualClicks: number
  /** projectedAnnualClicks − annualized current clicks. */
  upliftAnnualClicks: number
}

/**
 * One mega-impression hub: page with 100K+ impressions and sub-2% CTR.
 * These are usually the highest-ROI title/meta rewrite targets.
 */
export interface MegaImpressionHub {
  page: string
  clicks: number
  impressions: number
  ctr: number
  position: number
  /** Calibrated top-3 CTR for the tier the page sits in. */
  projectedCtr: number
  /** Calibrated additional clicks if CTR moved to projectedCtr. */
  projectedAdditionalClicks: number
}

/**
 * Power-page concentration. % of total clicks that come from the top N pages,
 * for several N values. High concentration = algorithm-update vulnerability.
 */
export interface PowerPageConcentration {
  totalPages: number
  totalClicks: number
  /** Cumulative click share at each top-N cutoff. */
  bands: { topN: number; clicks: number; sharePct: number }[]
  /** Pages it takes to reach 50% of clicks. */
  pagesToHalfOfClicks: number
}

/**
 * Aggregate of all GSC-derived analyses we hand to Claude pre-chewed.
 */
export interface AuditGscAnalyses {
  positionDistribution: PositionBand[]
  observedCtrTiers: ObservedCtrTier[]
  quickWins: QuickWinQuery[]
  megaImpressionHubs: MegaImpressionHub[]
  pageConcentration: PowerPageConcentration
  /** Clicks summed across the whole long-range window. */
  totalClicksLongRange: number
  totalImpressionsLongRange: number
}

/**
 * GA4 slice for the audit. Holds:
 *   - `currentYear`  — full last 12 months, for sessions / users / conversions.
 *   - `priorYear`    — the 12 months before that, for YoY commentary
 *                      (optional — newer partners may not have it).
 *   - `monthlyOrganic` — month-by-month organic sessions for the last 12
 *                        months. Used for the seasonality commentary.
 *   - `channelBreakdown` — session counts by default channel grouping for
 *                          the last 12 months, so the audit can call out
 *                          how dependent the partner is on organic search.
 */
export interface AuditGa4Slice {
  currentYear: GA4SeoReport
  priorYear?: GA4SeoReport
  monthlyOrganic: GA4MonthlyOrganicRow[]
  channelBreakdown: GA4ChannelRow[]
}

export interface GA4MonthlyOrganicRow {
  /** YYYY-MM. */
  month: string
  sessions: number
  conversions: number
  engagementDurationSec: number
}

export interface GA4ChannelRow {
  channel: string
  sessions: number
  users: number
  conversions: number
}

// ── Claude synthesis output (what the PDF renders) ────────────────────────

/**
 * Structured audit output Claude produces. Deliberately rigid: the PDF
 * template binds to these exact fields, and the "max 7 findings" hard
 * constraint is enforced in the prompt (anything beyond 7 is pushed into
 * `appendix_issues` as one-liners).
 */
export interface AuditFinding {
  /** 1-indexed — Claude uses these numbers in the roadmap cross-references. */
  number: number
  title: string
  /** 1–2 sentence body. Must cite a specific URL, count, or percentage. */
  detail: string
  /** Single bolded number that makes the finding concrete. */
  headlineMetric: string
  /** Optional business-impact translation (sessions → leads → revenue). */
  businessImpact?: string
}

export interface AuditRoadmapItem {
  /** Month 1 / Month 2 / Month 3. */
  phase: "Month 1" | "Month 2" | "Month 3"
  title: string
  /** Must reference findings by number, e.g. "Resolves Finding #3". */
  description: string
  findingRefs: number[]
}

export interface AuditTrafficAnalysis {
  summary: string
  sessionsCurrent: number
  sessionsPrior: number
  sessionsDeltaPct: number
  conversionsCurrent: number
  conversionsPrior: number
  conversionsDeltaPct: number
  /** The "good news buried in bad news" (or vice-versa) signal, if any. */
  nuance?: string
  topPagesLost: { page: string; sessionsLost: number; deltaPct: number }[]
}

export interface AuditCompetitiveTable {
  markets: TargetMarket[]
  rows: {
    domain: string
    isProspect: boolean
    perMarket: {
      city: string
      state: string
      organicKeywords: number
      organicTraffic: number
    }[]
  }[]
  /** 1–2 sentence read of the table. Must name a competitor by domain. */
  narrative: string
}

export interface AuditTechnicalFinding {
  title: string
  /** Concrete URL or count. */
  evidence: string
  businessImpact: string
}

export interface AuditBacklinkRisk {
  summary: string
  averageSpamScore: number
  highSpamCount: number
  /** Exact domains to cite in the PDF. */
  spamExamples: string[]
}

/**
 * Backlink Profile section. Populated when overall low-quality share
 * (>30% of referring domains) OR new-link low-quality share (>40% of
 * links acquired in the last 12 months) trips the threshold. The
 * `tier1` flag fires when new-link low-quality share exceeds 60% — Claude
 * must surface it in the executive summary as well.
 */
export interface AuditBacklinkProfileSection {
  totalBacklinks: number
  totalReferringDomains: number
  /** 0–1 fraction. */
  dofollowRatio: number
  anchorDiversity: number
  highQualityDomains: number
  lowQualityDomains: number
  newLinksLast12Months: number
  newLinksLast12MonthsLowQuality: number
  /** Domain strings to cite verbatim in the PDF. */
  sampleLowQualityLinks: string[]
  /** True when new-link low-quality share > 60% — Tier 1 finding required. */
  tier1: boolean
  narrative: string
}

/**
 * Section 3a — Position Distribution narrative. Numbers come from the
 * server-computed `AuditGscAnalyses.positionDistribution`, but the narrative
 * is Claude's read of the table.
 */
export interface AuditPositionDistribution {
  bands: PositionBand[]
  narrative: string
}

/**
 * Section 3b — Partner's Own Observed CTR Benchmarks. Tiers come from
 * `AuditGscAnalyses.observedCtrTiers`. The narrative names the tiers and
 * explains the AI Overview suppression effect honestly.
 */
export interface AuditObservedCtrBenchmarks {
  tiers: ObservedCtrTier[]
  narrative: string
}

/**
 * Section 3c — CTR Opportunity Quantification. Total uplift estimate, with
 * Claude's narrative explaining the calibration.
 */
export interface AuditCtrOpportunity {
  /** The total uplift, calibrated against partner's own observed CTRs. */
  estimatedAnnualClickUplift: number
  /** Number of queries contributing to the estimate. */
  contributingQueryCount: number
  /** Honest narrative referencing AI Overview suppression. */
  narrative: string
}

/**
 * Section 3d — Power Page Concentration. Echoes the server-computed values
 * with Claude's risk read.
 */
export interface AuditPowerPageConcentration {
  bands: { topN: number; clicks: number; sharePct: number }[]
  pagesToHalfOfClicks: number
  narrative: string
}

/**
 * Section 3e — Topic Cluster Performance. Claude clusters the query list
 * inside the synthesis prompt (no separate API call) and reports per-cluster
 * volume + CTR, then names the underperforming cluster as a content target.
 */
export interface AuditTopicCluster {
  name: string
  queryCount: number
  totalClicks: number
  totalImpressions: number
  averageCtr: number
  averagePosition: number
  /** Claude's qualitative read of this cluster's performance. */
  notes: string
}

export interface AuditTopicClusters {
  clusters: AuditTopicCluster[]
  /** Cluster name flagged as the highest-leverage content target. */
  highestLeverageCluster: string
  narrative: string
}

/**
 * Sections 3f + 3g — Quick wins + Mega-impression hubs. Server pre-computes
 * the candidates from the GSC data; Claude picks the most prospect-friendly
 * slice and writes the narrative.
 */
export interface AuditQuickWins {
  queries: QuickWinQuery[]
  narrative: string
}

export interface AuditMegaImpressionHubs {
  pages: MegaImpressionHub[]
  narrative: string
}

/**
 * Section 3h — Local Performance. One row per service area / city. When the
 * partner has GSC, counts come from filtering the query export by city tokens
 * appearing in the query string. Otherwise falls back to DataForSEO competitor
 * comparison only.
 */
export interface AuditLocalPerformanceRow {
  city: string
  state: string
  rankingsCount: number
  topThreeCount: number
  totalClicks: number
  totalImpressions: number
}

export interface AuditLocalPerformance {
  rows: AuditLocalPerformanceRow[]
  narrative: string
}

// ── PageSpeed Insights ─────────────────────────────────────────────────────
//
// PageSpeed Insights API output, normalized to the subset we actually use in
// the audit. Mobile is the primary signal because that's what Google ranks
// on; desktop is captured for completeness but findings are mobile-first.
//
// `inpMs` and other CrUX-derived metrics may be null when the page has too
// little real-user data for Google to publish a percentile. Lab metrics
// (LCP/CLS/TTFB from Lighthouse) are usually present even on cold sites.

export interface PageSpeedOpportunity {
  /** Lighthouse audit id, e.g. "render-blocking-resources". */
  id: string
  /** Human-readable title from the Lighthouse audit. */
  title: string
  /** Estimated savings in milliseconds, when the audit reports them. */
  estimatedSavingsMs?: number
}

export interface PageSpeedMetrics {
  /** 0–100, rounded. Null when Lighthouse failed for this strategy. */
  performanceScore: number | null
  /** Largest Contentful Paint in milliseconds. Null when unavailable. */
  lcpMs: number | null
  /** Interaction to Next Paint in milliseconds (CrUX field data). */
  inpMs: number | null
  /** Cumulative Layout Shift (unitless). */
  cls: number | null
  /** Time to First Byte in milliseconds. */
  ttfbMs: number | null
  /** Top-3 Lighthouse opportunities sorted by estimated savings desc. */
  opportunities: PageSpeedOpportunity[]
}

export interface PageSpeedUrlResult {
  url: string
  /** Mobile metrics — the primary signal because Google ranks on mobile. */
  mobile: PageSpeedMetrics | null
  /** Desktop metrics — secondary, for context only. */
  desktop: PageSpeedMetrics | null
  /** Populated when both strategies failed for this URL. */
  error?: string
}

export interface PageSpeedReport {
  /** Whether the homepage was included in the audited set. */
  homepageIncluded: boolean
  /** Homepage URL audited (canonical form, with trailing slash). */
  homepageUrl: string
  /** Per-URL results in the order they were submitted. */
  pages: PageSpeedUrlResult[]
  /** Aggregates computed off mobile metrics — see CLAUDE.md notes. */
  aggregates: {
    /** Average mobile performance score across pages with a score. */
    averageMobileScore: number | null
    /** Mobile score for the homepage, when audited. */
    homepageMobileScore: number | null
    /** Mobile score < 50. */
    lowScorePages: { url: string; score: number }[]
    /** Mobile LCP > 2500 ms. */
    poorLcpPages: { url: string; lcpMs: number }[]
    /** Mobile CLS > 0.1. */
    poorClsPages: { url: string; cls: number }[]
  }
  /**
   * Number of URLs we tried but skipped (not present in this report) for
   * any reason. Surfaced for transparency only — non-fatal.
   */
  skippedCount: number
  /** When the API key was missing and the whole pass was skipped. */
  skippedReason?: string
}

/**
 * Performance section emitted by Claude synthesis when at least one audited
 * page has a mobile performance score below 70. Mirrors the shape of other
 * synthesis sub-sections (positionDistribution, etc.) — narrative is
 * Claude's read; the lists are echoed from the server-computed aggregates.
 */
export interface AuditPerformanceSection {
  averageMobileScore: number | null
  homepageMobileScore: number | null
  lowScorePages: { url: string; score: number }[]
  poorLcpPages: { url: string; lcpMs: number }[]
  poorClsPages: { url: string; cls: number }[]
  narrative: string
}

// ────────────────────────────────────────────────────────────────────────────
// Assessment workflow (Audit tab + Competitive Analysis tab) — stateless,
// in-memory only. The shared frontend context in `components/AssessmentProvider.tsx`
// lives until page refresh; there is no persistence layer.

/** GSC slice the assessment Audit tab returns to the client. */
export interface AssessmentGscData {
  siteUrl: string
  /** Last 16 months — the GSC retention max. */
  dateRange: { startDate: string; endDate: string }
  totalClicks: number
  totalImpressions: number
  topQueries: GSCTopQueryRow[]
  topPages: GSCTopPageRow[]
  dailyClicks: GSCDailyRow[]
  /**
   * 90-day indexation-coverage proxy. Null when the sitemap is empty, the
   * URL Inspection call failed before producing any data, or the call wasn't
   * attempted (e.g. site verification mismatch). See `IndexCoverageReport`.
   */
  indexCoverage: IndexCoverageReport | null
}

/** GA4 slice the assessment Audit tab returns to the client. */
export interface AssessmentGa4Data {
  propertyId: string
  dateRange: { startDate: string; endDate: string }
  sessions: number
  users: number
  conversions: number
  conversionsConfigured: boolean
  organicLandingPages: GA4LandingPage[]
  channelBreakdown: GA4ChannelRow[]
  monthlyOrganic: GA4MonthlyOrganicRow[]
}

/** Single row of competitive comparison output (one row per domain × location). */
export interface CompAnalysisDomainRow {
  domain: string
  isPartner: boolean
  top3: number
  top10: number
  top20: number
  top100: number
  referringDomains: number
  pagesIndexed: number
  /** Pre-formatted compact-thousands string ("894", "1.2k", "22.4k"). */
  organicTraffic: string
  /** Raw integer value before formatting — useful for sorting. */
  organicTrafficRaw: number
  /** Set when DataForSEO calls failed for this (domain, location) pair. */
  failed?: boolean
}

export interface CompAnalysisLocationRows {
  /** Display label, e.g. "Sarasota,Florida,United States". */
  location: string
  /** DataForSEO Labs taxonomy code that was used (City, State, etc.). */
  locationCode: number
  /** "City" / "State" / "County" / "Region" / "Country" — from the DFS row. */
  locationType: string
  domains: CompAnalysisDomainRow[]
}

export interface AuditCrawlSummary {
  domain: string
  pagesAnalyzed: number
  durationMs: number
  missingTitles: number
  missingDescriptions: number
  duplicateTitles: number
  duplicateDescriptions: number
  thinContentPages: number
  spaShellPages: number
  schemaTypesPresent: string[]
}

export interface AssessmentAuditResult {
  websiteUrl: string
  generatedAt: string
  auditMarkdown: string
  warnings: string[]
  gscData: AssessmentGscData | null
  ga4Data: AssessmentGa4Data | null
  crawlSummary: AuditCrawlSummary | null
  cannibalization: CannibalizationCluster[]
  durationSeconds: number
}

/**
 * Keyword cannibalization cluster — a set of 2+ pages on the prospect's site
 * that compete with each other for the same keyword/location combination.
 *
 * `sharedSignal` records WHY the cluster was flagged so Claude can pick the
 * right remediation (consolidate vs. differentiate). `topQuery` is populated
 * only for `serp_overlap` clusters.
 */
export type CannibalizationSignal =
  | "identical_title"
  | "title_similarity"
  | "url_pattern"
  | "serp_overlap"

export type CannibalizationRecommendation =
  | "consolidate_to_stronger"
  | "differentiate_intent"

export interface CannibalizationCluster {
  /** 2+ absolute URLs of competing pages. */
  cluster: string[]
  sharedSignal: CannibalizationSignal
  /** Populated for serp_overlap. */
  topQuery?: string
  /** Populated for identical_title / title_similarity. */
  sharedTitle?: string
  recommendationHint: CannibalizationRecommendation
}

export interface AuditSynthesis {
  prospectDomain: string
  prospectName?: string
  generatedAt: string
  executiveSummary: string
  keyFindings: AuditFinding[]
  appendixIssues: string[]
  trafficAnalysis?: AuditTrafficAnalysis
  keywordVisibility: AuditCompetitiveTable
  topPagesToRecover?: { page: string; reasoning: string }[]
  technicalFindings: AuditTechnicalFinding[]
  backlinkRisk: AuditBacklinkRisk
  /**
   * Backlink Profile section. Populated only when low_quality% > 30% of
   * referring domains OR new-link low-quality share > 40%. Otherwise null /
   * absent — Claude is instructed to omit the field rather than fabricate.
   */
  backlinkProfile?: AuditBacklinkProfileSection | null
  roadmap: AuditRoadmapItem[]
  /** Section 3a–3h — only populated when GSC data is available. */
  positionDistribution?: AuditPositionDistribution
  observedCtrBenchmarks?: AuditObservedCtrBenchmarks
  ctrOpportunity?: AuditCtrOpportunity
  pageConcentration?: AuditPowerPageConcentration
  topicClusters?: AuditTopicClusters
  quickWins?: AuditQuickWins
  megaImpressionHubs?: AuditMegaImpressionHubs
  localPerformance?: AuditLocalPerformance
  /**
   * PageSpeed-driven Performance section. Populated only when the audit
   * pipeline ran the PageSpeed pass AND at least one audited page had a
   * mobile performance score below 70 (see CLAUDE.md → Audit tab).
   */
  performance?: AuditPerformanceSection
  dataSources: {
    crawlPagesAnalyzed: number
    gscIncluded: boolean
    ga4Included: boolean
    /** True when GSC long-range covered <6 months — caps trend commentary. */
    gscShortHistory: boolean
    competitorsAutoSuggested: boolean
    /** True when partner data was pulled from Airtable; false for raw prospect. */
    partnerDriven: boolean
    /** True when the PageSpeed pass actually ran (key configured). */
    pageSpeedIncluded?: boolean
  }
  /** Populated by the PDF route before upload, used for the footer note. */
  costUsd?: number
  durationSeconds?: number
}

// ────────────────────────────────────────────────────────────────────────────
// Onboarding tab — Initial Strategy workflow.
//
// Generates the strategic deliverables needed to brief a developer building a
// new site for a Partner: keyword-to-page mapping, URL redirect mapping, and
// internal linking plan. Distinct from the Audit tab (pre-sales, Prospect) and
// the Strategy tab (recurring 6-month cycle, markdown narrative). Output is a
// 3-sheet XLSX consumed by the developer + SEO engineer during the build.

/**
 * One node in the proposed-sitemap tree parsed from the indented text input.
 * Path is the breadcrumb chain ("Services > Plumbing > Drain Cleaning") and is
 * what the keyword/linking outputs reference, so a renamed page in the source
 * indented text changes the references everywhere consistently.
 */
export interface SitemapNode {
  /** Page name as written in the indented text. */
  name: string
  /** Breadcrumb path joined with " > ". Unique within the tree. */
  path: string
  /** 0 for root, 1 for top-level pages, etc. */
  depth: number
  /** Slug derived from `name` — Claude can override in the URL mapping output. */
  proposedSlug: string
  children: SitemapNode[]
}

/**
 * One row of the keyword-to-page mapping. Primary keyword is the single
 * keyword the page should rank #1 for; secondaries are supporting terms the
 * same page should naturally cover.
 */
export interface KeywordMapping {
  /** Page name from the proposed sitemap. */
  pageName: string
  /** Breadcrumb path from the proposed sitemap (matches SitemapNode.path). */
  pagePath: string
  /** Proposed full URL path, e.g. "/services/plumbing/drain-cleaning". */
  newUrl: string
  primaryKeyword: string
  secondaryKeywords: string[]
  /** One-sentence reason this page won this primary keyword. */
  rationale: string
}

/**
 * One row of the old-URL → new-URL mapping. `newUrl` is null when no new page
 * is a meaningful destination (the page is being retired, content was rolled
 * into a parent, etc.) — Claude flags those with `redirectType: "none"` and
 * the `notes` field explains the call.
 */
export type RedirectType = "301" | "none"

export interface UrlMapping {
  /** Original URL crawled from the current site (absolute). */
  oldUrl: string
  /** New URL path on the rebuilt site, or null when no redirect is appropriate. */
  newUrl: string | null
  redirectType: RedirectType
  notes: string
}

/**
 * One internal-link recommendation. Source and target both reference pages
 * from the proposed sitemap. Anchor text is the exact text the developer
 * should put inside the `<a>` tag on the source page.
 */
export interface InternalLink {
  sourcePage: string
  sourcePath: string
  sourceUrl: string
  targetPage: string
  targetPath: string
  targetUrl: string
  anchorText: string
  /** One-sentence reason this link helps (topical authority, user flow, etc.). */
  rationale: string
}

/**
 * Aggregate output of the Initial Strategy workflow. Returned to the client as
 * JSON; the client renders preview tables and offers an XLSX download whose
 * three sheets correspond 1-1 to these arrays.
 */
export interface InitialStrategyOutput {
  partnerId: string
  partnerName: string
  generatedAt: string
  keywordMapping: KeywordMapping[]
  urlMapping: UrlMapping[]
  internalLinking: InternalLink[]
  /** Pages that appeared in the proposed sitemap and ended up in the output. */
  sitemapPageCount: number
  /** Total URLs returned by the current-site crawl. */
  crawledUrlCount: number
  costUsd: number
  durationSeconds: number
  /** Non-fatal issues for the UI to surface (e.g. "12 keywords were not used"). */
  warnings: string[]
}
