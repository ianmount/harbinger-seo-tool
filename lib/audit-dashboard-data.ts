import GithubSlugger from "github-slugger"
import type {
  AssessmentAuditResult,
  AssessmentGa4Data,
  AssessmentGscData,
  CannibalizationCluster,
  CompAnalysisLocationRows,
  GA4MonthlyOrganicRow,
  GSCTopPageRow,
  GSCTopQueryRow,
  InspectedUrl,
} from "@/lib/types"

/**
 * Display-layer shapes the dashboard consumes. The dashboard route and the
 * standalone HTML export both run through `buildDashboardData()` so they
 * stay in sync; if a section needs different framing, adjust here.
 */

export interface DashboardData {
  domain: string
  websiteUrl: string
  generatedAt: string
  durationMinutes: number
  summary: DashboardSummaryItem[]
  warnings: string[]
  executiveSummary: ExecutiveSummary
  indexation: IndexationSection | null
  cannibalization: CannibalizationSection
  traffic: TrafficSection | null
  competitors: CompetitorsSection | null
  schema: SchemaSection | null
  opportunities: OpportunitiesSection | null
  topPages: TopPagesSection | null
  performance: PerformanceSection | null
  narrative: NarrativeSection
}

export interface DashboardSummaryItem {
  label: string
  value: string
  hint?: string
}

export interface ExecutiveSummary {
  headline: string
  bullets: string[]
}

export interface IndexationSection {
  siteUrl: string
  windowStart: string
  windowEnd: string
  sitemapCount: number
  indexedCount: number
  notIndexed: NotIndexedRow[]
  /** True when at least one inspected sample was successfully retrieved. */
  hasInspectionData: boolean
}

export interface NotIndexedRow {
  url: string
  pattern: string
  /** Human-readable last-crawl from the URL Inspection sample, when available. */
  lastCrawl: string | null
  coverageState: string | null
  verdict: string | null
}

export interface CannibalizationSection {
  clusters: CannibalizationClusterDisplay[]
  totalUrls: number
}

export interface CannibalizationClusterDisplay extends CannibalizationCluster {
  /** Per-URL GSC stats joined when the URL appears in topPages. */
  urls: { url: string; clicks: number; impressions: number; position: number }[]
  signalLabel: string
  recommendationLabel: string
}

export interface TrafficSection {
  sessionsCurrent: number
  sessionsPrior: number
  sessionsDeltaPct: number | null
  conversionsCurrent: number
  conversionsConfigured: boolean
  /** Aligned 12-month series (YYYY-MM order). */
  series: TrafficSeriesPoint[]
  channels: { channel: string; sessions: number; sharePct: number }[]
}

export interface TrafficSeriesPoint {
  month: string
  /** "Apr 2025" form for display. */
  label: string
  current: number
  prior: number | null
}

export interface CompetitorsSection {
  /** Tabbed views — one per location. */
  locations: CompetitorLocationDisplay[]
}

export interface CompetitorLocationDisplay {
  label: string
  locationCode: number
  rows: {
    domain: string
    isPartner: boolean
    organicTraffic: string
    organicTrafficRaw: number
    top3: number
    top10: number
    referringDomains: number
    pagesIndexed: number
  }[]
}

export interface SchemaSection {
  typesPresent: string[]
  typesRecommended: string[]
  /** Matrix-friendly rows: one per recommended type with a present/missing flag. */
  matrix: { type: string; present: boolean; note: string }[]
}

export interface OpportunitiesSection {
  rows: OpportunityRow[]
}

export interface OpportunityRow {
  query: string
  clicks: number
  impressions: number
  position: number
  ctr: number
  /** Heuristic estimate of additional annual clicks if the query moves to top-3. */
  estimatedClickLift: number
}

export interface TopPagesSection {
  rows: GSCTopPageRow[]
}

export interface PerformanceSection {
  pagesAnalyzed: number
  durationMs: number
  missingTitles: number
  missingDescriptions: number
  duplicateTitles: number
  duplicateDescriptions: number
  thinContentPages: number
  spaShellPages: number
}

export interface NarrativeSection {
  /** Raw markdown narrative from Claude. */
  markdown: string
  /** Section-level outline parsed from the markdown for the TOC. */
  outline: { id: string; title: string; level: 2 | 3 }[]
}

// ─────────────────────────────────────────────────────────────────────────

const SIGNAL_LABEL: Record<CannibalizationCluster["sharedSignal"], string> = {
  identical_title: "Identical title",
  title_similarity: "Title similarity",
  url_pattern: "URL pattern",
  serp_overlap: "SERP overlap",
}

const RECOMMENDATION_LABEL: Record<
  CannibalizationCluster["recommendationHint"],
  string
> = {
  consolidate_to_stronger: "Consolidate into the stronger page",
  differentiate_intent: "Differentiate the search intent",
}

/**
 * Schema types we recommend a local-services site implement. Mirrors the
 * `typesExpected` set the crawler uses, but kept here so the dashboard can
 * render the matrix even when only `crawlSummary.schemaTypesPresent[]` is
 * available (the assessment route doesn't return the full bucket matrix).
 */
const RECOMMENDED_SCHEMA_TYPES: { type: string; note: string; aliases?: string[] }[] = [
  {
    type: "LocalBusiness",
    note: "Powers map pack and knowledge panel eligibility.",
    aliases: ["Plumber", "Electrician", "RoofingContractor", "HVACBusiness", "HomeAndConstructionBusiness", "ProfessionalService"],
  },
  { type: "Service", note: "Service-page eligibility for richer SERP treatments." },
  { type: "BreadcrumbList", note: "Breadcrumb display in search results." },
  { type: "FAQPage", note: "FAQ rich result on pages with common questions." },
  { type: "Review", note: "Review stars when paired with LocalBusiness." },
  { type: "Organization", note: "Brand/entity disambiguation." },
]

function pathPattern(url: string): string {
  try {
    const u = new URL(url)
    const parts = u.pathname.split("/").filter(Boolean)
    if (parts.length === 0) return "/ (homepage)"
    return "/" + parts.slice(0, 2).join("/") + (parts.length > 2 ? "/…" : "")
  } catch {
    return url
  }
}

function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toISOString().slice(0, 10)
}

function inspectionLookup(coverage: AssessmentGscData["indexCoverage"]):
  Map<string, InspectedUrl> {
  const m = new Map<string, InspectedUrl>()
  if (!coverage) return m
  for (const sample of coverage.inspectedSample) {
    m.set(sample.url, sample)
  }
  return m
}

function buildIndexation(
  gsc: AssessmentGscData | null,
): IndexationSection | null {
  if (!gsc?.indexCoverage) return null
  const cov = gsc.indexCoverage
  const samples = inspectionLookup(gsc.indexCoverage)
  const notIndexed: NotIndexedRow[] = cov.probablyNotIndexed.map((url) => {
    const sample = samples.get(url)
    return {
      url,
      pattern: pathPattern(url),
      lastCrawl: formatDate(sample?.lastCrawlTime ?? null),
      coverageState: sample?.coverageState ?? null,
      verdict: sample?.verdict ?? null,
    }
  })
  return {
    siteUrl: cov.siteUrl,
    windowStart: cov.dateRange.startDate,
    windowEnd: cov.dateRange.endDate,
    sitemapCount: cov.sitemapCount,
    indexedCount: cov.indexedUrls.length,
    notIndexed,
    hasInspectionData: cov.inspectedSample.some((s) => !s.error),
  }
}

function buildCannibalization(
  clusters: CannibalizationCluster[],
  topPages: GSCTopPageRow[],
): CannibalizationSection {
  const pageStats = new Map<string, GSCTopPageRow>()
  for (const p of topPages) pageStats.set(p.page, p)
  const display: CannibalizationClusterDisplay[] = clusters.map((c) => ({
    ...c,
    signalLabel: SIGNAL_LABEL[c.sharedSignal],
    recommendationLabel: RECOMMENDATION_LABEL[c.recommendationHint],
    urls: c.cluster.map((url) => {
      const stats = pageStats.get(url)
      return {
        url,
        clicks: stats?.clicks ?? 0,
        impressions: stats?.impressions ?? 0,
        position: stats?.position ?? 0,
      }
    }),
  }))
  const totalUrls = clusters.reduce((s, c) => s + c.cluster.length, 0)
  return { clusters: display, totalUrls }
}

function monthLabel(yyyymm: string): string {
  const [y, m] = yyyymm.split("-")
  if (!y || !m) return yyyymm
  const monthIdx = parseInt(m, 10) - 1
  const names = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ]
  return `${names[monthIdx] ?? m} ${y}`
}

/**
 * Split monthlyOrganic into current 12 months + prior 12 months and align
 * by month-of-year so the dashboard can render YoY at the same x position.
 */
function buildTrafficSeries(monthly: GA4MonthlyOrganicRow[]): TrafficSeriesPoint[] {
  if (monthly.length === 0) return []
  const sorted = [...monthly].sort((a, b) => a.month.localeCompare(b.month))
  const current = sorted.slice(-12)
  const prior = sorted.length > 12 ? sorted.slice(-24, -12) : []
  return current.map((row, i) => {
    const priorRow = prior[i]
    return {
      month: row.month,
      label: monthLabel(row.month),
      current: row.sessions,
      prior: priorRow ? priorRow.sessions : null,
    }
  })
}

function buildTraffic(ga4: AssessmentGa4Data | null): TrafficSection | null {
  if (!ga4) return null
  const sorted = [...ga4.monthlyOrganic].sort((a, b) =>
    a.month.localeCompare(b.month),
  )
  const current = sorted.slice(-12)
  const prior = sorted.length > 12 ? sorted.slice(-24, -12) : []
  const sessionsCurrent = current.reduce((s, r) => s + r.sessions, 0)
  const sessionsPrior = prior.reduce((s, r) => s + r.sessions, 0)
  const sessionsDeltaPct =
    sessionsPrior > 0 ? ((sessionsCurrent - sessionsPrior) / sessionsPrior) * 100 : null
  const conversionsCurrent = current.reduce((s, r) => s + r.conversions, 0)
  const totalChannels = ga4.channelBreakdown.reduce((s, c) => s + c.sessions, 0) || 1
  const channels = [...ga4.channelBreakdown]
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 6)
    .map((c) => ({
      channel: c.channel,
      sessions: c.sessions,
      sharePct: (c.sessions / totalChannels) * 100,
    }))
  return {
    sessionsCurrent,
    sessionsPrior,
    sessionsDeltaPct,
    conversionsCurrent,
    conversionsConfigured: ga4.conversionsConfigured,
    series: buildTrafficSeries(ga4.monthlyOrganic),
    channels,
  }
}

function buildCompetitors(
  rows: CompAnalysisLocationRows[] | null | undefined,
): CompetitorsSection | null {
  if (!rows || rows.length === 0) return null
  return {
    locations: rows.map((loc) => ({
      label: loc.location.replace(/,United States$/, "").replace(/,/g, ", "),
      locationCode: loc.locationCode,
      rows: loc.domains.map((d) => ({
        domain: d.domain,
        isPartner: d.isPartner,
        organicTraffic: d.organicTraffic,
        organicTrafficRaw: d.organicTrafficRaw,
        top3: d.top3,
        top10: d.top10,
        referringDomains: d.referringDomains,
        pagesIndexed: d.pagesIndexed,
      })),
    })),
  }
}

function buildSchema(typesPresent: string[]): SchemaSection {
  const presentSet = new Set(typesPresent)
  const matrix = RECOMMENDED_SCHEMA_TYPES.map((rec) => {
    const aliases = rec.aliases ?? []
    const present =
      presentSet.has(rec.type) || aliases.some((a) => presentSet.has(a))
    return { type: rec.type, present, note: rec.note }
  })
  return {
    typesPresent: typesPresent.slice().sort(),
    typesRecommended: RECOMMENDED_SCHEMA_TYPES.map((r) => r.type),
    matrix,
  }
}

function buildOpportunities(
  topQueries: GSCTopQueryRow[],
): OpportunitiesSection | null {
  if (topQueries.length === 0) return null
  // Quick-win heuristic: queries currently ranking 4–20 with non-trivial
  // impressions get an estimated click lift assuming a top-3 CTR of 18%.
  const TOP_THREE_CTR = 0.18
  const rows: OpportunityRow[] = topQueries
    .filter((q) => q.position >= 3 && q.position <= 25 && q.impressions > 25)
    .map((q) => {
      const projected = q.impressions * TOP_THREE_CTR
      const lift = Math.max(0, projected - q.clicks)
      return {
        query: q.query,
        clicks: q.clicks,
        impressions: q.impressions,
        position: q.position,
        ctr: q.ctr,
        estimatedClickLift: Math.round(lift),
      }
    })
    .sort((a, b) => b.estimatedClickLift - a.estimatedClickLift)
    .slice(0, 50)
  if (rows.length === 0) return null
  return { rows }
}

function buildTopPages(topPages: GSCTopPageRow[]): TopPagesSection | null {
  if (topPages.length === 0) return null
  return { rows: topPages.slice(0, 25) }
}

function buildPerformance(
  result: AssessmentAuditResult,
): PerformanceSection | null {
  const c = result.crawlSummary
  if (!c) return null
  return {
    pagesAnalyzed: c.pagesAnalyzed,
    durationMs: c.durationMs,
    missingTitles: c.missingTitles,
    missingDescriptions: c.missingDescriptions,
    duplicateTitles: c.duplicateTitles,
    duplicateDescriptions: c.duplicateDescriptions,
    thinContentPages: c.thinContentPages,
    spaShellPages: c.spaShellPages,
  }
}

function buildExecutiveSummary(
  result: AssessmentAuditResult,
): ExecutiveSummary {
  const md = result.auditMarkdown
  // Pull the first H2 section after the document title — typically labelled
  // "Executive Summary". Fall back to the first 6 bullet/paragraph lines.
  const lines = md.split("\n")
  let headline = result.websiteUrl
  const bulletLines: string[] = []
  let inSummary = false
  let foundFirstHeading = false
  for (const raw of lines) {
    const line = raw.trim()
    if (/^#\s+/.test(line)) {
      headline = line.replace(/^#\s+/, "")
      foundFirstHeading = true
      continue
    }
    if (/^##\s+/.test(line)) {
      if (inSummary) break
      // First H2 is treated as the summary header.
      if (foundFirstHeading) inSummary = true
      continue
    }
    if (inSummary && line) {
      bulletLines.push(line)
    }
  }
  // Convert markdown bullets to plain text — keep emphasis stripped.
  const bullets = bulletLines
    .filter((l) => l.startsWith("- ") || l.startsWith("* ") || /^\d+\.\s/.test(l))
    .map((l) => l.replace(/^([-*]|\d+\.)\s+/, "").replace(/\*+/g, ""))
    .slice(0, 7)
  if (bullets.length === 0) {
    // Fall back to the first ~5 non-empty paragraph lines.
    const para = bulletLines
      .filter((l) => !!l && !l.startsWith("#"))
      .slice(0, 5)
    return { headline, bullets: para.map((p) => p.replace(/\*+/g, "")) }
  }
  return { headline, bullets }
}

function buildOutline(markdown: string): NarrativeSection["outline"] {
  const out: NarrativeSection["outline"] = []
  // Match the slug algorithm used by rehype-slug (in-app dashboard) and
  // markdownToBasicHtml (HTML export). github-slugger handles dedupe with
  // a counter suffix internally — same instance must be used per call so
  // duplicate counters reset between audits.
  const slugger = new GithubSlugger()
  for (const line of markdown.split("\n")) {
    const m = /^(#{2,3})\s+(.*)$/.exec(line.trim())
    if (!m) continue
    const level = m[1].length === 2 ? 2 : 3
    const title = m[2].replace(/[*_`]/g, "").trim()
    if (!title) continue
    const id = slugger.slug(title)
    out.push({ id, title, level })
  }
  return out
}

function buildSummary(result: AssessmentAuditResult): DashboardSummaryItem[] {
  const items: DashboardSummaryItem[] = []
  if (result.crawlSummary) {
    items.push({
      label: "Pages crawled",
      value: result.crawlSummary.pagesAnalyzed.toString(),
      hint: `${result.crawlSummary.schemaTypesPresent.length} schema types in use`,
    })
  }
  if (result.gscData) {
    items.push({
      label: "GSC clicks (16 mo)",
      value: result.gscData.totalClicks.toLocaleString(),
      hint: `${result.gscData.totalImpressions.toLocaleString()} impressions`,
    })
  } else {
    items.push({ label: "GSC", value: "Not connected", hint: "Crawl-only audit" })
  }
  if (result.ga4Data) {
    items.push({
      label: "GA4 sessions (12 mo)",
      value: result.ga4Data.sessions.toLocaleString(),
      hint: result.ga4Data.conversionsConfigured
        ? `${result.ga4Data.conversions.toLocaleString()} conversions`
        : "Conversions not configured",
    })
  }
  items.push({
    label: "Cannibalization clusters",
    value: result.cannibalization.length.toString(),
  })
  return items
}

export function buildDashboardData(
  result: AssessmentAuditResult,
  options: {
    compAnalysisRows?: CompAnalysisLocationRows[] | null
  } = {},
): DashboardData {
  const minutes = Math.max(1, Math.round(result.durationSeconds / 60))
  let domain = result.websiteUrl
  try {
    const u = new URL(
      result.websiteUrl.startsWith("http")
        ? result.websiteUrl
        : `https://${result.websiteUrl}`,
    )
    domain = u.hostname.replace(/^www\./, "")
  } catch {
    // keep raw
  }
  const topPages = result.gscData?.topPages ?? []
  const topQueries = result.gscData?.topQueries ?? []
  return {
    domain,
    websiteUrl: result.websiteUrl,
    generatedAt: result.generatedAt,
    durationMinutes: minutes,
    summary: buildSummary(result),
    warnings: result.warnings,
    executiveSummary: buildExecutiveSummary(result),
    indexation: buildIndexation(result.gscData),
    cannibalization: buildCannibalization(result.cannibalization, topPages),
    traffic: buildTraffic(result.ga4Data),
    competitors: buildCompetitors(options.compAnalysisRows ?? null),
    schema: result.crawlSummary
      ? buildSchema(result.crawlSummary.schemaTypesPresent)
      : null,
    opportunities: buildOpportunities(topQueries),
    topPages: buildTopPages(topPages),
    performance: buildPerformance(result),
    narrative: {
      markdown: result.auditMarkdown,
      outline: buildOutline(result.auditMarkdown),
    },
  }
}

export const DASHBOARD_SECTIONS: { id: string; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "executive-summary", label: "Executive Summary" },
  { id: "indexation", label: "Indexation" },
  { id: "cannibalization", label: "Cannibalization" },
  { id: "traffic", label: "Traffic (YoY)" },
  { id: "competitors", label: "Competitors" },
  { id: "schema", label: "Schema Coverage" },
  { id: "opportunities", label: "Top Opportunities" },
  { id: "top-pages", label: "Top Landing Pages" },
  { id: "performance", label: "Site Health" },
  { id: "narrative", label: "Full Narrative" },
]
