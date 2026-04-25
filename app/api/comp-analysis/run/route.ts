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
 * Stateless. Accepts the prospect's domain, target locations, and a list
 * of competitor domains; runs DataForSEO ranked_keywords + domain_rank_overview
 * + backlinks/summary + site:domain SERP per (domain × location); aggregates
 * the position bucket counts; returns a JSON shape grouped by location plus
 * a pre-rendered CSV string.
 *
 * No GSC/GA4 — DataForSEO only.
 */
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

const targetLocationSchema = z.object({
  city: z.string().min(1),
  state: z.string().min(1),
})

const bodySchema = z.object({
  partnerUrl: z.string().min(3),
  targetLocations: z.array(targetLocationSchema).min(1).max(10),
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

/**
 * DataForSEO Labs rejects city-level location names for the keyword research
 * endpoints (status 40501). We roll up to state level for the comparison so
 * every (domain × location) cell uses a name DFS will accept. The CSV still
 * labels each location with the original "City, State" the user entered.
 */
function locationName(state: string): string {
  return `${state.trim()},United States`
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

/**
 * Per-domain metrics — independent of location. Single network round per
 * domain (one backlinks summary + one site:domain SERP). Errors yield zero
 * values rather than killing the whole run; the row gets flagged.
 */
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

/**
 * Per-(domain × location) metrics. Combines ranked_keyword position counts
 * with domain_rank_overview's organic ETV (estimated traffic).
 */
async function fetchLocationMetrics(
  domain: string,
  state: string,
): Promise<LocationMetrics> {
  const location = { name: locationName(state) }
  let counts = { top3: 0, top10: 0, top20: 0, top100: 0 }
  let organicTrafficRaw = 0
  let failed = false
  try {
    const c = await rankedKeywordPositionCounts(domain, location)
    counts = {
      top3: c.top3,
      top10: c.top10,
      top20: c.top20,
      top100: c.top100,
    }
  } catch (err) {
    failed = true
    console.warn(
      `[api/comp-analysis] rankedKeywordPositionCounts failed for ${domain} / ${state}:`,
      err,
    )
  }
  try {
    const overview = await domainRankOverview(domain, location)
    organicTrafficRaw = Math.round(overview.organicTraffic)
  } catch (err) {
    failed = true
    console.warn(
      `[api/comp-analysis] domainRankOverview failed for ${domain} / ${state}:`,
      err,
    )
  }
  return { ...counts, organicTrafficRaw, failed }
}

/**
 * Concurrency-limited mapping. Caps DataForSEO calls at ~5 parallel to
 * avoid rate limits.
 */
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

function buildCsv(rows: CompAnalysisLocationRows[]): string {
  const lines: string[] = []
  lines.push(
    "Website,Top 3,Top 10,Top 20,Top 100,Referring Domains,Pages Indexed,Organic Traffic",
  )
  for (let i = 0; i < rows.length; i++) {
    const loc = rows[i]
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

function csvEscape(v: string): string {
  if (v.includes(",") || v.includes('"') || v.includes("\n")) {
    return `"${v.replace(/"/g, '""')}"`
  }
  return v
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

  // Validate locations parse — they're already structured by the schema, so
  // just guard against empty state.
  for (const loc of body.targetLocations) {
    if (!loc.state.trim()) {
      return NextResponse.json(
        {
          error: `Location "${loc.city}" has no state. Use "City, State" format.`,
        },
        { status: 400 },
      )
    }
  }

  try {
    // 1. Per-domain metrics (referring domains + pages indexed).
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

    // 2. Per-(domain × location) ranked_keyword + traffic metrics.
    const tasks: Array<{ domain: string; locationIdx: number }> = []
    for (const domain of allDomains) {
      for (let li = 0; li < body.targetLocations.length; li++) {
        tasks.push({ domain, locationIdx: li })
      }
    }
    const taskResults = await mapWithConcurrency(tasks, 5, (t) =>
      fetchLocationMetrics(t.domain, body.targetLocations[t.locationIdx].state),
    )

    // 3. Group results by location, partner first, competitors sorted by Top10.
    const rows: CompAnalysisLocationRows[] = []
    for (let li = 0; li < body.targetLocations.length; li++) {
      const loc = body.targetLocations[li]
      const partnerRow = (() => {
        const idx = tasks.findIndex(
          (t) => t.domain === partnerDomain && t.locationIdx === li,
        )
        const m = taskResults[idx]
        const dm = domainMetrics.get(partnerDomain)!
        return buildRow({
          domain: partnerDomain,
          isPartner: true,
          loc: m,
          dm,
        })
      })()
      const competitorRows: CompAnalysisDomainRow[] = competitorDomains.map(
        (d) => {
          const idx = tasks.findIndex(
            (t) => t.domain === d && t.locationIdx === li,
          )
          const m = taskResults[idx]
          const dm = domainMetrics.get(d)!
          return buildRow({ domain: d, isPartner: false, loc: m, dm })
        },
      )
      competitorRows.sort((a, b) => b.top10 - a.top10)
      rows.push({
        location: `${loc.city}, ${loc.state}`,
        domains: [partnerRow, ...competitorRows],
      })
    }

    // 4. Roll up failures into warnings.
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
