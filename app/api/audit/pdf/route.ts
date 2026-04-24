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
import { crawlSite } from "@/lib/crawler"
import {
  referringDomainsWithSpamScore,
} from "@/lib/dataforseo"
import { getSeoReport } from "@/lib/ga4"
import {
  getDailyClicks,
  getTopPages,
  getTopQueries,
} from "@/lib/gsc"
import { env } from "@/lib/env"
import type {
  AuditGa4Slice,
  AuditGscSlice,
  AuditSynthesis,
  CompetitiveReport,
  Prospect,
} from "@/lib/types"

/**
 * End-to-end audit orchestrator.
 *
 * Chains: crawl (own lib) → GSC (optional) → GA4 (optional, current + prior
 * year quarter) → competitive (calls own /api/audit/competitive internally) →
 * backlinks (own lib) → Claude synthesis (calls own /api/claude/audit
 * internally) → render PDF → upload to Vercel Blob.
 *
 * Crawl + competitive + backlinks run in parallel. GSC + GA4 run in parallel
 * when provided. Claude synthesis waits on all of them. The whole pipeline
 * is wrapped in withAuditCost so every DataForSEO call and Claude call
 * reports into a single accumulator that ends up in the PDF footer.
 *
 * Runs on Node runtime (crawler uses node:crypto transitively via cheerio,
 * Blob SDK uses node streams). Max duration 300s — full audits run 3-8 min.
 */
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

// ────────────────────────────────────────────────────────────────────────────
// Request schema.

const targetMarketSchema = z.object({
  city: z.string().min(1),
  state: z.string().min(1),
})

const bodySchema = z.object({
  prospect: z.object({
    domain: z.string().min(3),
    targetMarkets: z.array(targetMarketSchema).min(1).max(5),
    competitors: z.array(z.string().min(3)).max(5),
    gscSiteUrl: z.string().optional(),
    ga4PropertyId: z.string().optional(),
    contactName: z.string().optional(),
  }),
  /**
   * Optional seed services for auto-suggesting competitors. Only used when
   * prospect.competitors is empty. e.g. ["plumber", "drain cleaning"].
   */
  seedServices: z.array(z.string().min(2)).max(5).optional(),
})

// ────────────────────────────────────────────────────────────────────────────
// Helpers.

/**
 * Return the most recently COMPLETED calendar quarter as an ISO date range,
 * plus the same quarter a year prior. Used for the GA4 YoY comparison
 * following the vendor doc's format.
 */
function priorYearQuarter(now: Date = new Date()): {
  current: { startDate: string; endDate: string }
  prior: { startDate: string; endDate: string }
} {
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth() // 0-11
  // Find the most recent completed quarter relative to `now`.
  const quarterOfMonth = (month: number) => Math.floor(month / 3)
  const currentQuarterIndex = quarterOfMonth(m)
  const lastCompletedQ = currentQuarterIndex === 0 ? 3 : currentQuarterIndex - 1
  const lastCompletedQYear = currentQuarterIndex === 0 ? y - 1 : y
  const start = new Date(Date.UTC(lastCompletedQYear, lastCompletedQ * 3, 1))
  const end = new Date(
    Date.UTC(lastCompletedQYear, lastCompletedQ * 3 + 3, 0), // day 0 of next month = last day of prev month
  )
  const priorStart = new Date(
    Date.UTC(lastCompletedQYear - 1, lastCompletedQ * 3, 1),
  )
  const priorEnd = new Date(
    Date.UTC(lastCompletedQYear - 1, lastCompletedQ * 3 + 3, 0),
  )
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  return {
    current: { startDate: fmt(start), endDate: fmt(end) },
    prior: { startDate: fmt(priorStart), endDate: fmt(priorEnd) },
  }
}

/** 16-byte random slug for the public Blob URL. hex → 32 chars; easily unguessable. */
function generateSlug(): string {
  return randomBytes(16).toString("hex")
}

/**
 * POST to one of our own /api/audit/* routes. Using fetch here rather than
 * a direct function import because the intermediate routes already validate
 * inputs and log — no reason to duplicate. The AsyncLocalStorage cost tracker
 * survives across fetch because the route handlers don't cross realms; the
 * DataForSEO/Claude helpers inside those routes will still see the active
 * store as long as they run in-process. (Next.js runs all internal fetches
 * to `/api/*` in the same server process.)
 */
async function internalPost<T>(path: string, body: unknown, baseUrl: string): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    // Forward the auth cookie implicitly is not possible here (no request
    // context); these routes don't require auth themselves — middleware
    // protects the /api boundary but trusted server-to-server calls can
    // bypass by going through the same origin. For the MVP this is fine.
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
// Pipeline. Each stage runs concurrently where possible; GSC/GA4 are optional.

interface PipelineResult {
  synthesis: AuditSynthesis
  pdfBuffer: Buffer
}

async function runPipeline(params: {
  prospect: Prospect
  seedServices: string[]
  baseUrl: string
}): Promise<PipelineResult> {
  const { prospect, seedServices, baseUrl } = params

  // Parallel: crawl + competitive + backlinks + (optional) GSC + (optional) GA4.
  const crawlPromise = crawlSite({ domain: prospect.domain })

  const competitivePromise = internalPost<{ report: CompetitiveReport }>(
    "/api/audit/competitive",
    {
      prospectDomain: prospect.domain,
      competitors: prospect.competitors,
      targetMarkets: prospect.targetMarkets,
      seedServices,
    },
    baseUrl,
  ).then((r) => r.report)

  const backlinksPromise = referringDomainsWithSpamScore(prospect.domain)

  const gscPromise: Promise<AuditGscSlice | undefined> = prospect.gscSiteUrl
    ? (async () => {
        // 90-day window ending today. Keeps the slice tight and fast.
        const end = new Date()
        const start = new Date(end.getTime() - 90 * 24 * 60 * 60 * 1000)
        const fmt = (d: Date) => d.toISOString().slice(0, 10)
        const startDate = fmt(start)
        const endDate = fmt(end)
        const siteUrl = prospect.gscSiteUrl as string
        try {
          const [topQueries, topPages, daily] = await Promise.all([
            getTopQueries({ siteUrl, startDate, endDate, rowLimit: 100 }),
            getTopPages({ siteUrl, startDate, endDate, rowLimit: 100 }),
            getDailyClicks({ siteUrl, startDate, endDate }),
          ])
          const totalClicks = daily.reduce((s, d) => s + d.clicks, 0)
          const totalImpressions = daily.reduce((s, d) => s + d.impressions, 0)
          return {
            siteUrl,
            dateRange: { startDate, endDate },
            totalClicks,
            totalImpressions,
            topQueries,
            topPages,
          }
        } catch (err) {
          console.warn("[api/audit/pdf] GSC fetch failed, continuing without:", err)
          return undefined
        }
      })()
    : Promise.resolve(undefined)

  const ga4Promise: Promise<AuditGa4Slice | undefined> = prospect.ga4PropertyId
    ? (async () => {
        const { current, prior } = priorYearQuarter()
        const propertyId = prospect.ga4PropertyId as string
        try {
          const [cur, prev] = await Promise.all([
            getSeoReport({
              propertyId,
              startDate: current.startDate,
              endDate: current.endDate,
            }),
            getSeoReport({
              propertyId,
              startDate: prior.startDate,
              endDate: prior.endDate,
            }).catch(() => undefined),
          ])
          return { current: cur, prior: prev }
        } catch (err) {
          console.warn("[api/audit/pdf] GA4 fetch failed, continuing without:", err)
          return undefined
        }
      })()
    : Promise.resolve(undefined)

  const [crawl, competitive, backlinks, gsc, ga4] = await Promise.all([
    crawlPromise,
    competitivePromise,
    backlinksPromise,
    gscPromise,
    ga4Promise,
  ])

  console.log(
    `[api/audit/pdf] data collection done: crawl=${crawl.crawledCount}pp competitive=${competitive.rows.length}rows backlinks=${backlinks.referringDomains}rd gsc=${gsc ? "yes" : "no"} ga4=${ga4 ? "yes" : "no"}`,
  )

  // Claude synthesis (goes through the dedicated route so the system prompt
  // lives in one place).
  const synthesisRes = await internalPost<{ synthesis: AuditSynthesis }>(
    "/api/claude/audit",
    {
      prospect,
      crawl,
      competitive,
      backlinks,
      gsc,
      ga4,
    },
    baseUrl,
  )
  const synthesis = synthesisRes.synthesis

  // Stamp crawl stats Claude couldn't know without us telling it.
  synthesis.dataSources = {
    crawlPagesAnalyzed: crawl.crawledCount,
    gscIncluded: Boolean(gsc),
    ga4Included: Boolean(ga4),
    competitorsAutoSuggested: competitive.competitorsAutoSuggested,
  }

  // Crawl + backlinks reports aren't returned to the caller — they're
  // already baked into the synthesis. Omit to keep the response tight.
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

  const prospect: Prospect = parsed.data.prospect
  const seedServices = parsed.data.seedServices ?? []

  if (!env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      {
        error:
          "BLOB_READ_WRITE_TOKEN is not set. Create a Vercel Blob store (Storage → Create → Blob) and add BLOB_READ_WRITE_TOKEN to Settings → Environment Variables, then redeploy.",
      },
      { status: 500 },
    )
  }

  const baseUrl = baseUrlFromRequest(request)
  const accumulator = createCostAccumulator()
  const startedAt = Date.now()

  try {
    const result = await withAuditCost(accumulator, () =>
      runPipeline({ prospect, seedServices, baseUrl }),
    )

    const durationSeconds = Math.round((Date.now() - startedAt) / 1000)
    const cost = totalCostUsd(accumulator)
    result.synthesis.durationSeconds = durationSeconds
    result.synthesis.costUsd = cost

    // Re-render once with cost/duration baked in so they appear in the footer.
    // Cheap compared to data collection (~1-2s).
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
      `[api/audit/pdf] domain=${prospect.domain} duration=${durationSeconds}s cost=$${cost.toFixed(3)} (dfs=$${accumulator.dataforseoUsd.toFixed(3)} claude=$${accumulator.claudeUsd.toFixed(3)}) url=${blob.url}`,
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
