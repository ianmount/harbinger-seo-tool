import { NextResponse } from "next/server"
import { z } from "zod"
import {
  DataForSEOError,
  domainRankOverview,
  indexedPageCount,
  rankedKeywordPositionCounts,
  referringDomainCount,
} from "@/lib/dataforseo"
import type {
  CompAnalysisDomainRow,
  CompAnalysisLocationRows,
} from "@/lib/types"

/**
 * Competitive Analysis endpoint.
 *
 * Stateless. Accepts the prospect's domain, a list of DataForSEO-validated
 * locations (each with a real `location_code` from DFS's taxonomy), and a
 * list of competitor domains. Runs DataForSEO ranked_keywords +
 * domain_rank_overview + backlinks/summary + site:domain SERP per
 * (domain × location); aggregates the position bucket counts; returns a
 * JSON shape grouped by location plus a pre-rendered CSV string.
 *
 * Locations come from the same `/api/dataforseo/locations` lookup the
 * Keyword Research tab uses, so every code passed here is one DFS already
 * accepts — no city-vs-state probing needed on the server side.
 *
 * No GSC/GA4 — DataForSEO only.
 */
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

const dfsLocationSchema = z.object({
  location_code: z.number().int().positive(),
  location_name: z.string().min(1),
  location_type: z.string().min(1),
})

const bodySchema = z.object({
  partnerUrl: z.string().min(3),
  /**
   * DataForSEO-validated locations (from `/api/dataforseo/locations`).
   * Each carries a real DFS Labs location_code that ranked_keywords /
   * domain_rank_overview accept directly.
   */
  targetLocations: z.array(dfsLocationSchema).min(1).max(10),
  competitorUrls: z.array(z.string().min(3)).min(1).max(20),
})

type Body = z.infer<typeof bodySchema>

function cleanDomain(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase()
}

function compactThousands(n: number): string {
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`
  }
  return String(Math.round(n))
}

interface DomainMetrics {
  referringDomains: number
  pagesIndexed: number
}

async function fetchDomainMetrics(
  domain: string,
): Promise<DomainMetrics & { failed?: boolean }> {
  let referringDomains = 0
  let pagesIndexed = 0
  let failed = false
  try {
    referringDomains = await referringDomainCount(domain)
  } catch (err) {
    failed = true
    console.warn(
      `[api/comp-analysis] referringDomainCount failed for ${domain}:`,
      err,
    )
  }
  try {
    pagesIndexed = await indexedPageCount(domain)
  } catch (err) {
    failed = true
    console.warn(
      `[api/comp-analysis] indexedPageCount failed for ${domain}:`,
      err,
    )
  }
  return { referringDomains, pagesIndexed, failed }
}

interface LocationMetrics {
  top3: number
  top10: number
  top20: number
  top100: number
  organicTrafficRaw: number
  failed?: boolean
}

async function fetchLocationMetrics(
  domain: string,
  locationCode: number,
): Promise<LocationMetrics> {
  const dfsLoc = { code: locationCode }
  let counts = { top3: 0, top10: 0, top20: 0, top100: 0 }
  let organicTrafficRaw = 0
  let failed = false
  try {
    const c = await rankedKeywordPositionCounts(domain, dfsLoc)
    counts = { top3: c.top3, top10: c.top10, top20: c.top20, top100: c.top100 }
  } catch (err) {
    failed = true
    console.warn(
      `[api/comp-analysis] rankedKeywordPositionCounts failed for ${domain} / ${locationCode}:`,
      err,
    )
  }
  try {
    const overview = await domainRankOverview(domain, dfsLoc)
    organicTrafficRaw = Math.round(overview.organicTraffic)
  } catch (err) {
    failed = true
    console.warn(
      `[api/comp-analysis] domainRankOverview failed for ${domain} / ${locationCode}:`,
      err,
    )
  }
  return { ...counts, organicTrafficRaw, failed }
}

async function mapWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results: U[] = new Array(items.length)
  let next = 0
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const i = next++
        if (i >= items.length) return
        results[i] = await fn(items[i], i)
      }
    },
  )
  await Promise.all(workers)
  return results
}

function csvEscape(v: string): string {
  if (v.includes(",") || v.includes('"') || v.includes("\n")) {
    return `"${v.replace(/"/g, '""')}"`
  }
  return v
}

function buildCsv(rows: CompAnalysisLocationRows[]): string {
  const lines: string[] = []
  lines.push(
    "Website,Top 3,Top 10,Top 20,Top 100,Referring Domains,Pages Indexed,Organic Traffic",
  )
  for (const loc of rows) {
    lines.push(",,,,,,,")
    lines.push(`${csvEscape(loc.location)},,,,,,,`)
    for (const d of loc.domains) {
      lines.push(
        [
          csvEscape(d.domain),
          d.top3,
          d.top10,
          d.top20,
          d.top100,
          d.referringDomains,
          d.pagesIndexed,
          csvEscape(d.organicTraffic),
        ].join(","),
      )
    }
  }
  return lines.join("\n")
}

function buildRow(params: {
  domain: string
  isPartner: boolean
  loc: LocationMetrics
  dm: DomainMetrics & { failed?: boolean }
}): CompAnalysisDomainRow {
  const { domain, isPartner, loc, dm } = params
  return {
    domain,
    isPartner,
    top3: loc.top3,
    top10: loc.top10,
    top20: loc.top20,
    top100: loc.top100,
    referringDomains: dm.referringDomains,
    pagesIndexed: dm.pagesIndexed,
    organicTraffic: compactThousands(loc.organicTrafficRaw),
    organicTrafficRaw: loc.organicTrafficRaw,
    failed: loc.failed || dm.failed,
  }
}

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
  const body: Body = parsed.data

  const partnerDomain = cleanDomain(body.partnerUrl)
  const competitorDomains = body.competitorUrls
    .map(cleanDomain)
    .filter((d) => d.length > 0 && d !== partnerDomain)
  const allDomains = [partnerDomain, ...competitorDomains]
  const warnings: string[] = []

  try {
    // Per-domain metrics (referring domains + pages indexed) — independent
    // of location, so one call per domain.
    const domainMetrics = new Map<
      string,
      DomainMetrics & { failed?: boolean }
    >()
    const metricsResults = await mapWithConcurrency(allDomains, 5, (d) =>
      fetchDomainMetrics(d),
    )
    for (let i = 0; i < allDomains.length; i++) {
      domainMetrics.set(allDomains[i], metricsResults[i])
    }

    // Per-(domain × location) metrics. All codes are pre-validated by
    // DataForSEO so we just pass them straight through.
    const tasks: Array<{ domain: string; locationIdx: number }> = []
    for (const domain of allDomains) {
      for (let li = 0; li < body.targetLocations.length; li++) {
        tasks.push({ domain, locationIdx: li })
      }
    }
    const taskResults = await mapWithConcurrency(tasks, 5, (t) =>
      fetchLocationMetrics(t.domain, body.targetLocations[t.locationIdx].location_code),
    )

    // Group by location, partner first, competitors sorted by Top 10 desc.
    const rows: CompAnalysisLocationRows[] = []
    for (let li = 0; li < body.targetLocations.length; li++) {
      const loc = body.targetLocations[li]
      const partnerIdx = tasks.findIndex(
        (t) => t.domain === partnerDomain && t.locationIdx === li,
      )
      const partnerRow = buildRow({
        domain: partnerDomain,
        isPartner: true,
        loc: taskResults[partnerIdx],
        dm: domainMetrics.get(partnerDomain)!,
      })
      const competitorRows: CompAnalysisDomainRow[] = competitorDomains.map(
        (d) => {
          const idx = tasks.findIndex(
            (t) => t.domain === d && t.locationIdx === li,
          )
          return buildRow({
            domain: d,
            isPartner: false,
            loc: taskResults[idx],
            dm: domainMetrics.get(d)!,
          })
        },
      )
      competitorRows.sort((a, b) => b.top10 - a.top10)
      rows.push({
        location: loc.location_name,
        locationCode: loc.location_code,
        locationType: loc.location_type,
        domains: [partnerRow, ...competitorRows],
      })
    }

    for (const r of rows) {
      for (const d of r.domains) {
        if (d.failed) {
          warnings.push(
            `Some DataForSEO calls failed for ${d.domain} in ${r.location} — figures shown are partial.`,
          )
        }
      }
    }

    const csv = buildCsv(rows)
    return NextResponse.json({ rows, csv, warnings })
  } catch (error) {
    console.error("[api/comp-analysis/run] failed:", error)
    const status = error instanceof DataForSEOError ? 502 : 500
    const message = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json({ error: message }, { status })
  }
}
