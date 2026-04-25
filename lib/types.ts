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

/** Per-URL result from the cheerio crawl. */
export interface CrawledPage {
  url: string
  finalUrl: string
  status: number
  /** True if the HTTP chain included at least one redirect. */
  redirected: boolean
  title: string | null
  metaDescription: string | null
  metaRobots: string | null
  canonical: string | null
  h1s: string[]
  h2Count: number
  /** JSON-LD schema blocks parsed from <script type="application/ld+json">. */
  schemaTypes: string[]
  /** <img> tags total vs. ones with non-empty alt. */
  imagesTotal: number
  imagesWithAlt: number
  internalLinks: number
  wordCount: number
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
 */
export interface CrawlReport {
  domain: string
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
}

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
  dataSources: {
    crawlPagesAnalyzed: number
    gscIncluded: boolean
    ga4Included: boolean
    /** True when GSC long-range covered <6 months — caps trend commentary. */
    gscShortHistory: boolean
    competitorsAutoSuggested: boolean
    /** True when partner data was pulled from Airtable; false for raw prospect. */
    partnerDriven: boolean
  }
  /** Populated by the PDF route before upload, used for the footer note. */
  costUsd?: number
  durationSeconds?: number
}
