import { NextResponse } from "next/server"
import { put } from "@vercel/blob"
import { randomBytes } from "node:crypto"
import { z } from "zod"
import {
  createCostAccumulator,
  totalCostUsd,
  withAuditCost,
} from "@/lib/audit-cost"
import { renderAuditPdf } from "@/lib/audit-pdf"
import { buildGscAnalyses } from "@/lib/audit-analyses"
import { getPartner } from "@/lib/airtable"
import { crawlSite } from "@/lib/crawler"
import { referringDomainsWithSpamScore } from "@/lib/dataforseo"
import {
  getChannelBreakdown,
  getMonthlyOrganic,
  getSeoReport,
  listProperties,
} from "@/lib/ga4"
import {
  getDailyClicks,
  getTopPagesPaginated,
  getTopQueriesPaginated,
  listSites,
  partnerWebsiteToGscSiteUrl,
} from "@/lib/gsc"
import { findGa4PropertyCandidates } from "@/lib/ga4-site-match"
import { findGscSiteCandidates } from "@/lib/gsc-site-match"
import { env } from "@/lib/env"
import type {
  AuditGa4Slice,
  AuditGscSlice,
  AuditGscWindow,
  AuditSynthesis,
  CompetitiveReport,
  Partner,
  Prospect,
  TargetMarket,
} from "@/lib/types"

/**
 * End-to-end audit orchestrator.
 *
 * Two entry shapes:
 *   1. **Partner mode** — `{ partnerId }`. The orchestrator resolves the
 *      partner from Airtable and auto-attaches GSC + GA4 the same way the
 *      Reporting tab does. This is the default for partners we serve.
 *   2. **Pre-sales mode** — `{ prospect, seedServices }`. Raw prospect data
 *      entered manually by the MD; GSC/GA4 are typically not connected
 *      and the audit falls back to crawl + DataForSEO + third-party
 *      estimates. The PDF is clearly marked as running on third-party data.
 *
 * The pipeline runs crawl + competitive + backlinks + (optional) GSC +
 * (optional) GA4 in parallel, then folds everything into the Claude
 * synthesis call. Wrapped in withAuditCost so per-call DataForSEO and
 * Claude costs land in the PDF footer.
 *
 * Node runtime, 300s max — full audits run 3-8 min.
 */
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

// ────────────────────────────────────────────────────────────────────────────
// Request schema. Accept either partner mode or pre-sales mode; reject
// payloads that supply neither or both.

const targetMarketSchema = z.object({
  city: z.string().min(1),
  state: z.string().min(1),
})

const prospectInputSchema = z.object({
  domain: z.string().min(3),
  targetMarkets: z.array(targetMarketSchema).min(1).max(5),
  competitors: z.array(z.string().min(3)).max(5),
  gscSiteUrl: z.string().optional(),
  ga4PropertyId: z.string().optional(),
  contactName: z.string().optional(),
})

const bodySchema = z
  .object({
    partnerId: z.string().min(1).optional(),
    prospect: prospectInputSchema.optional(),
    seedServices: z.array(z.string().min(2)).max(5).optional(),
    /**
     * `"full"` (default) crawls every URL in the sitemap; `"sample"` caps at
     * 50 prioritized URLs for fast testing.
     */
    crawlMode: z.enum(["full", "sample"]).optional(),
  })
  .refine((b) => Boolean(b.partnerId) !== Boolean(b.prospect), {
    message: "Provide either partnerId or prospect, not both",
  })

// ────────────────────────────────────────────────────────────────────────────
// Helpers.

/** 16-byte random slug for the public Blob URL. hex → 32 chars; unguessable. */
function generateSlug(): string {
  return randomBytes(16).toString("hex")
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Today minus N days, ISO. */
function isoDaysAgo(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  return fmtDate(d)
}

/** Today minus N months, ISO. Uses calendar months, not 30-day chunks. */
function isoMonthsAgo(months: number): string {
  const d = new Date()
  d.setUTCMonth(d.getUTCMonth() - months)
  return fmtDate(d)
}

/**
 * Forward the incoming auth cookie on internal /api/audit/* hops. The proxy
 * gates everything behind harbinger_auth so internal fetches need it too.
 */
async function internalPost<T>(
  path: string,
  body: unknown,
  baseUrl: string,
  cookie: string | null,
): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(
      `${path} failed: HTTP ${res.status} ${text.slice(0, 300)}`,
    )
  }
  return (await res.json()) as T
}

function baseUrlFromRequest(request: Request): string {
  const hdrHost = request.headers.get("host")
  if (hdrHost) {
    const proto = request.headers.get("x-forwarded-proto") ?? "https"
    return `${proto}://${hdrHost}`
  }
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  }
  return "http://localhost:3000"
}

// ────────────────────────────────────────────────────────────────────────────
// Partner → Prospect translation.
//
// When the audit is run against a partner, we synthesize a Prospect from
// their Airtable record so the rest of the pipeline (crawler, competitive
// rollup, backlinks) doesn't need a separate code path. Service Areas are
// parsed line-by-line into TargetMarket entries; lines that can't be parsed
// fall back to the raw text in `city` with empty `state`.

const STATE_ABBREV: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
  MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina",
  ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee",
  TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia",
}

const STATE_NAMES = new Set(Object.values(STATE_ABBREV).map((s) => s.toLowerCase()))

function parseServiceAreas(raw: string | undefined): TargetMarket[] {
  if (!raw) return []
  const lines = raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const out: TargetMarket[] = []
  for (const line of lines) {
    // "City, ST" or "City, FullState" — accept both.
    const m = line.match(/^([^,]+?),\s*([A-Za-z. ]+)$/)
    if (m) {
      const city = m[1].trim()
      const stateRaw = m[2].trim().replace(/\.$/, "")
      const upper = stateRaw.toUpperCase()
      if (STATE_ABBREV[upper]) {
        out.push({ city, state: STATE_ABBREV[upper] })
        continue
      }
      if (STATE_NAMES.has(stateRaw.toLowerCase())) {
        out.push({ city, state: stateRaw })
        continue
      }
    }
    // Fallback: keep the raw text in city so the user sees it on the report.
    out.push({ city: line, state: "" })
  }
  // Cap at 5 — competitive rollup costs money per market.
  return out.slice(0, 5)
}

function partnerToProspect(partner: Partner): Prospect {
  const websiteHostMatch = partner.website
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase()
  return {
    domain: websiteHostMatch,
    targetMarkets: parseServiceAreas(partner.serviceAreas).filter(
      (m) => m.city && m.state,
    ),
    competitors: [],
    contactName: partner.name,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// GSC site + GA4 property auto-resolution.
//
// Mirrors the Reporting tab's flow exactly: list everything the authed
// account can see, filter by hostname / Airtable override, take the
// highest-ranked candidate. Returns null when nothing matches so the
// pipeline can downgrade to a "GSC not connected" branch without throwing.

async function autoResolveGscSiteUrl(partner: Partner): Promise<string | null> {
  try {
    const sites = await listSites("assessments")
    const matches = findGscSiteCandidates(partner.website, sites)
    return matches[0]?.siteUrl ?? null
  } catch (err) {
    console.warn("[api/audit/pdf] GSC site auto-resolve failed:", err)
    return null
  }
}

async function autoResolveGa4PropertyId(
  partner: Partner,
): Promise<string | null> {
  // Airtable explicit override always wins.
  if (partner.ga4PropertyId) {
    const raw = partner.ga4PropertyId.trim()
    return raw.startsWith("properties/") ? raw : `properties/${raw}`
  }
  try {
    const props = await listProperties({ account: "assessments" })
    const matches = findGa4PropertyCandidates(partner.website, props)
    return matches[0]?.propertyId ?? null
  } catch (err) {
    console.warn("[api/audit/pdf] GA4 property auto-resolve failed:", err)
    return null
  }
}

// ────────────────────────────────────────────────────────────────────────────
// GSC slice for the audit. Pulls 16-month long range + 90-day recent in
// parallel, then derives all the analyses we hand to Claude pre-chewed.

async function buildGscSlice(siteUrl: string): Promise<AuditGscSlice | null> {
  try {
    // GSC retains ~16 months. Pull both pages and queries for the full
    // window, then a separate 90-day slice for the recent CTR baseline.
    const longStart = isoMonthsAgo(16)
    const longEnd = isoDaysAgo(2) // GSC data is ~2 days lagged
    const recentStart = isoDaysAgo(90)
    const recentEnd = longEnd

    const [
      longTopQueries,
      longTopPages,
      recentTopQueries,
      recentDaily,
      longDaily,
    ] = await Promise.all([
      getTopQueriesPaginated({
        account: "assessments",
        siteUrl,
        startDate: longStart,
        endDate: longEnd,
        maxRows: 25_000,
      }),
      getTopPagesPaginated({
        account: "assessments",
        siteUrl,
        startDate: longStart,
        endDate: longEnd,
        maxRows: 25_000,
      }),
      getTopQueriesPaginated({
        account: "assessments",
        siteUrl,
        startDate: recentStart,
        endDate: recentEnd,
        maxRows: 25_000,
      }),
      getDailyClicks({
        account: "assessments",
        siteUrl,
        startDate: recentStart,
        endDate: recentEnd,
      }),
      getDailyClicks({
        account: "assessments",
        siteUrl,
        startDate: longStart,
        endDate: longEnd,
      }),
    ])

    const longTotalClicks = longDaily.reduce((s, d) => s + d.clicks, 0)
    const longTotalImpressions = longDaily.reduce(
      (s, d) => s + d.impressions,
      0,
    )
    const recentTotalClicks = recentDaily.reduce((s, d) => s + d.clicks, 0)
    const recentTotalImpressions = recentDaily.reduce(
      (s, d) => s + d.impressions,
      0,
    )

    const longRange: AuditGscWindow = {
      dateRange: { startDate: longStart, endDate: longEnd },
      totalClicks: longTotalClicks,
      totalImpressions: longTotalImpressions,
      topQueries: longTopQueries,
      topPages: longTopPages,
    }
    const recent: AuditGscWindow = {
      dateRange: { startDate: recentStart, endDate: recentEnd },
      totalClicks: recentTotalClicks,
      totalImpressions: recentTotalImpressions,
      topQueries: recentTopQueries,
      topPages: [],
    }

    const analyses = buildGscAnalyses({
      longRangeTopQueries: longTopQueries,
      longRangeTopPages: longTopPages,
      recentTopQueries,
      longRangeMonths: 16,
    })

    return { siteUrl, longRange, recent, analyses }
  } catch (err) {
    console.warn("[api/audit/pdf] GSC slice fetch failed:", err)
    return null
  }
}

// ────────────────────────────────────────────────────────────────────────────
// GA4 slice. Full last 12 months + same window prior year + monthly organic
// trend + channel breakdown, all in parallel.

async function buildGa4Slice(propertyId: string): Promise<AuditGa4Slice | null> {
  try {
    const today = new Date()
    const yearEnd = fmtDate(today)
    const yearStartDate = new Date(today)
    yearStartDate.setUTCFullYear(yearStartDate.getUTCFullYear() - 1)
    yearStartDate.setUTCDate(yearStartDate.getUTCDate() + 1)
    const yearStart = fmtDate(yearStartDate)

    const priorYearEnd = fmtDate(
      new Date(yearStartDate.getTime() - 24 * 60 * 60 * 1000),
    )
    const priorYearStartDate = new Date(yearStartDate)
    priorYearStartDate.setUTCFullYear(priorYearStartDate.getUTCFullYear() - 1)
    const priorYearStart = fmtDate(priorYearStartDate)

    const [currentYear, priorYear, monthlyOrganic, channelBreakdown] =
      await Promise.all([
        getSeoReport({
          account: "assessments",
          propertyId,
          startDate: yearStart,
          endDate: yearEnd,
        }),
        getSeoReport({
          account: "assessments",
          propertyId,
          startDate: priorYearStart,
          endDate: priorYearEnd,
        }).catch(() => undefined),
        getMonthlyOrganic({
          account: "assessments",
          propertyId,
          startDate: yearStart,
          endDate: yearEnd,
        }),
        getChannelBreakdown({
          account: "assessments",
          propertyId,
          startDate: yearStart,
          endDate: yearEnd,
        }),
      ])

    return { currentYear, priorYear, monthlyOrganic, channelBreakdown }
  } catch (err) {
    console.warn("[api/audit/pdf] GA4 slice fetch failed:", err)
    return null
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Pipeline.

interface PipelineResult {
  synthesis: AuditSynthesis
  pdfBuffer: Buffer
}

async function runPipeline(params: {
  prospect: Prospect
  seedServices: string[]
  partnerDriven: boolean
  resolvedGscSiteUrl: string | null
  resolvedGa4PropertyId: string | null
  crawlMode: "full" | "sample"
  baseUrl: string
  cookie: string | null
}): Promise<PipelineResult> {
  const {
    prospect,
    seedServices,
    partnerDriven,
    resolvedGscSiteUrl,
    resolvedGa4PropertyId,
    crawlMode,
    baseUrl,
    cookie,
  } = params

  const crawlPromise = crawlSite({
    domain: prospect.domain,
    options: { mode: crawlMode },
  })

  const competitivePromise = internalPost<{ report: CompetitiveReport }>(
    "/api/audit/competitive",
    {
      prospectDomain: prospect.domain,
      competitors: prospect.competitors,
      targetMarkets:
        prospect.targetMarkets.length > 0
          ? prospect.targetMarkets
          : [{ city: prospect.domain, state: "" }],
      seedServices,
    },
    baseUrl,
    cookie,
  ).then((r) => r.report)

  const backlinksPromise = referringDomainsWithSpamScore(prospect.domain)

  const gscSiteUrl = resolvedGscSiteUrl ?? prospect.gscSiteUrl ?? null
  const gscPromise: Promise<AuditGscSlice | null> = gscSiteUrl
    ? buildGscSlice(gscSiteUrl)
    : Promise.resolve(null)

  const ga4PropertyId = resolvedGa4PropertyId ?? prospect.ga4PropertyId ?? null
  const ga4Promise: Promise<AuditGa4Slice | null> = ga4PropertyId
    ? buildGa4Slice(ga4PropertyId)
    : Promise.resolve(null)

  const [crawl, competitive, backlinks, gsc, ga4] = await Promise.all([
    crawlPromise,
    competitivePromise,
    backlinksPromise,
    gscPromise,
    ga4Promise,
  ])

  console.log(
    `[api/audit/pdf] data: crawl=${crawl.crawledCount}pp competitive=${competitive.rows.length}rows backlinks=${backlinks.referringDomains}rd gsc=${gsc ? "yes" : "no"} ga4=${ga4 ? "yes" : "no"}`,
  )

  // Detect short GSC history so the prompt + report can scale down trend
  // commentary rather than fabricate seasonality from 2 months of data.
  let gscShortHistory = false
  if (gsc) {
    const start = new Date(gsc.longRange.dateRange.startDate)
    const end = new Date(gsc.longRange.dateRange.endDate)
    const months =
      (end.getTime() - start.getTime()) / (30 * 24 * 60 * 60 * 1000)
    // The window is requested at 16 months; if the data only covers <6
    // months it means the property is newer than that. (We use the daily-
    // clicks coverage as a proxy: if there are no clicks in older months
    // it's effectively a short history regardless of the requested range.)
    if (months < 6) gscShortHistory = true
  }

  const synthesisRes = await internalPost<{ synthesis: AuditSynthesis }>(
    "/api/claude/audit",
    {
      prospect,
      partnerDriven,
      crawl,
      competitive,
      backlinks,
      gsc,
      ga4,
      gscShortHistory,
    },
    baseUrl,
    cookie,
  )
  const synthesis = synthesisRes.synthesis

  synthesis.dataSources = {
    crawlPagesAnalyzed: crawl.crawledCount,
    gscIncluded: Boolean(gsc),
    ga4Included: Boolean(ga4),
    gscShortHistory,
    competitorsAutoSuggested: competitive.competitorsAutoSuggested,
    partnerDriven,
  }

  void crawl
  void backlinks

  const pdfBuffer = await renderAuditPdf(synthesis)
  return { synthesis, pdfBuffer }
}

// ────────────────────────────────────────────────────────────────────────────
// POST handler.

export async function POST(request: Request) {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON" },
      { status: 400 },
    )
  }
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request body", issues: parsed.error.flatten() },
      { status: 400 },
    )
  }

  if (!env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      {
        error:
          "BLOB_READ_WRITE_TOKEN is not set. Create a Vercel Blob store (Storage → Create → Blob) and add BLOB_READ_WRITE_TOKEN to Settings → Environment Variables, then redeploy.",
      },
      { status: 500 },
    )
  }

  const seedServices = parsed.data.seedServices ?? []
  const baseUrl = baseUrlFromRequest(request)
  const cookie = request.headers.get("cookie")

  // Resolve to a Prospect + optional auto-resolved GSC/GA4 ids.
  let prospect: Prospect
  let partnerDriven = false
  let resolvedGscSiteUrl: string | null = null
  let resolvedGa4PropertyId: string | null = null

  try {
    if (parsed.data.partnerId) {
      const partner = await getPartner(parsed.data.partnerId)
      if (!partner) {
        return NextResponse.json(
          { error: `Partner not found: ${parsed.data.partnerId}` },
          { status: 404 },
        )
      }
      prospect = partnerToProspect(partner)
      partnerDriven = true

      // Auto-resolve GSC + GA4 in parallel — same flow as Reporting tab.
      const [gscSite, ga4Prop] = await Promise.all([
        autoResolveGscSiteUrl(partner),
        autoResolveGa4PropertyId(partner),
      ])
      // GSC: if no candidate matched but the partner has a website, fall
      // back to deriving the URL-prefix form. The Reporting tab does the
      // same as a final attempt before erroring out.
      resolvedGscSiteUrl =
        gscSite ?? partnerWebsiteToGscSiteUrl(partner.website)
      // GSC fetch will fail gracefully if the derived URL isn't actually
      // verified for the SEO Ops account; that's fine — the pipeline
      // downgrades to a "GSC not connected" branch.
      resolvedGa4PropertyId = ga4Prop
    } else if (parsed.data.prospect) {
      prospect = parsed.data.prospect
    } else {
      return NextResponse.json(
        { error: "Provide partnerId or prospect" },
        { status: 400 },
      )
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json(
      { error: `Failed to load partner: ${message}` },
      { status: 500 },
    )
  }

  if (prospect.targetMarkets.length === 0) {
    return NextResponse.json(
      {
        error:
          "No target markets resolved. For partner mode, populate Service Areas in Airtable as 'City, ST' lines; for pre-sales mode, supply targetMarkets explicitly.",
      },
      { status: 400 },
    )
  }

  const accumulator = createCostAccumulator()
  const startedAt = Date.now()

  try {
    const result = await withAuditCost(accumulator, () =>
      runPipeline({
        prospect,
        seedServices,
        partnerDriven,
        resolvedGscSiteUrl,
        resolvedGa4PropertyId,
        crawlMode: parsed.data.crawlMode ?? "full",
        baseUrl,
        cookie,
      }),
    )

    const durationSeconds = Math.round((Date.now() - startedAt) / 1000)
    const cost = totalCostUsd(accumulator)
    result.synthesis.durationSeconds = durationSeconds
    result.synthesis.costUsd = cost

    // Re-render once with cost/duration baked in so they appear in the footer.
    const finalPdf = await renderAuditPdf(result.synthesis)

    const slug = generateSlug()
    const safeDomain = prospect.domain.replace(/[^a-zA-Z0-9.-]/g, "_")
    const pathname = `audits/${safeDomain}/${slug}.pdf`

    const blob = await put(pathname, finalPdf, {
      access: "public",
      contentType: "application/pdf",
      addRandomSuffix: false,
      token: env.BLOB_READ_WRITE_TOKEN,
    })

    console.log(
      `[api/audit/pdf] domain=${prospect.domain} partner=${partnerDriven} duration=${durationSeconds}s cost=$${cost.toFixed(3)} url=${blob.url}`,
    )

    return NextResponse.json({
      url: blob.url,
      synthesis: result.synthesis,
      durationSeconds,
      costUsd: cost,
      costBreakdown: {
        dataforseoUsd: accumulator.dataforseoUsd,
        claudeUsd: accumulator.claudeUsd,
        dataforseoCalls: accumulator.dataforseoCalls,
        claudeInputTokens: accumulator.claudeInputTokens,
        claudeOutputTokens: accumulator.claudeOutputTokens,
      },
    })
  } catch (error) {
    console.error("[api/audit/pdf] pipeline failed:", error)
    const message = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
