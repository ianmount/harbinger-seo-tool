import { NextResponse } from "next/server"
import { z } from "zod"
import {
  DataForSEOError,
  domainRankOverview,
  indexedPageCount,
  isLabsCityRejection,
  rankedKeywordPositionCounts,
  referringDomainCount,
  resolveLabsCityCode,
} from "@/lib/dataforseo"
import type {
  CompAnalysisDomainRow,
  CompAnalysisLocationRows,
  DfsLocation,
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
 * City vs. state granularity:
 *   - For each location we look up the DataForSEO Labs city-level
 *     location_code via the cached Google Ads US locations list.
 *   - If found, we attempt the call at city level. DataForSEO Labs only
 *     accepts a subset of city codes — smaller cities are rejected with
 *     status 40501. The first 40501 we hit for a given location flips
 *     that location to state-level for the rest of the run.
 *   - If the city isn't in the taxonomy at all, we skip the city attempt
 *     and go straight to state. The CSV row labels keep the original
 *     "City, State" string regardless.
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

/**
 * Per-location resolver state. Mutable: the first call to attempt a
 * location's city code records whether the Labs taxonomy accepts it; all
 * subsequent calls for the same location reuse that decision rather than
 * re-attempting city. Scoped to one POST request — no module-level state.
 */
interface LocationRuntime {
  city: string
  state: string
  /** Resolved DFS code if the city is in the taxonomy at all. */
  cityCode: number | null
  /**
   * "unknown" until the first call resolves; "city" or "state" thereafter.
   * Concurrent attempts share the same in-flight Promise via `decision`.
   */
  granularity: "unknown" | "city" | "state"
  /** In-flight probe so concurrent callers share one decision. */
  decision: Promise<"city" | "state"> | null
}

class LocationResolver {
  private locations = new Map<string, LocationRuntime>()

  async init(targetLocations: { city: string; state: string }[]): Promise<void> {
    // Pre-resolve city codes in parallel so the first probe doesn't pay
    // the locations-list latency.
    await Promise.all(
      targetLocations.map(async (loc) => {
        const cityCode = await resolveLabsCityCode(loc.city, loc.state)
        this.locations.set(this.key(loc), {
          city: loc.city,
          state: loc.state,
          cityCode,
          granularity: cityCode == null ? "state" : "unknown",
          decision: null,
        })
      }),
    )
  }

  private key(loc: { city: string; state: string }): string {
    return `${loc.city.toLowerCase()}|${loc.state.toLowerCase()}`
  }

  /** Final granularity used by a location, set after at least one call ran. */
  granularity(loc: { city: string; state: string }): "city" | "state" {
    const rt = this.locations.get(this.key(loc))
    if (!rt) return "state"
    return rt.granularity === "unknown" ? "state" : rt.granularity
  }

  /** DFS location to use right now for a (domain, location) call. */
  current(loc: { city: string; state: string }): DfsLocation {
    const rt = this.locations.get(this.key(loc))
    if (!rt) return { name: `${loc.state},United States` }
    if (rt.granularity === "city" && rt.cityCode != null) {
      return { code: rt.cityCode }
    }
    if (rt.granularity === "state") {
      return { name: `${rt.state},United States` }
    }
    // unknown — try city
    return rt.cityCode != null
      ? { code: rt.cityCode }
      : { name: `${rt.state},United States` }
  }

  /** Mark the location as state-level after a city-rejection. */
  recordCityRejection(loc: { city: string; state: string }): void {
    const rt = this.locations.get(this.key(loc))
    if (rt) rt.granularity = "state"
  }

  /** Mark the location as city-level after a successful city-level call. */
  recordCitySuccess(loc: { city: string; state: string }): void {
    const rt = this.locations.get(this.key(loc))
    if (rt && rt.granularity === "unknown") rt.granularity = "city"
  }
}

async function fetchLocationMetrics(
  domain: string,
  loc: { city: string; state: string },
  resolver: LocationResolver,
): Promise<LocationMetrics> {
  // Try with current best guess. If we get a Labs city-rejection, mark the
  // location state-level and retry once at state granularity. Other errors
  // mark the cell `failed: true`.
  let dfsLoc = resolver.current(loc)
  let counts = { top3: 0, top10: 0, top20: 0, top100: 0 }
  let organicTrafficRaw = 0
  let failed = false

  const tryWith = async (l: DfsLocation): Promise<{ ok: boolean; cityRejected: boolean }> => {
    try {
      const c = await rankedKeywordPositionCounts(domain, l)
      counts = { top3: c.top3, top10: c.top10, top20: c.top20, top100: c.top100 }
    } catch (err) {
      if (isLabsCityRejection(err) && "code" in l) {
        return { ok: false, cityRejected: true }
      }
      console.warn(
        `[api/comp-analysis] rankedKeywordPositionCounts failed for ${domain} / ${loc.city}, ${loc.state}:`,
        err,
      )
      failed = true
      return { ok: false, cityRejected: false }
    }
    try {
      const overview = await domainRankOverview(domain, l)
      organicTrafficRaw = Math.round(overview.organicTraffic)
    } catch (err) {
      if (isLabsCityRejection(err) && "code" in l) {
        return { ok: false, cityRejected: true }
      }
      console.warn(
        `[api/comp-analysis] domainRankOverview failed for ${domain} / ${loc.city}, ${loc.state}:`,
        err,
      )
      failed = true
      return { ok: true, cityRejected: false }
    }
    return { ok: true, cityRejected: false }
  }

  let result = await tryWith(dfsLoc)
  if (result.cityRejected) {
    resolver.recordCityRejection(loc)
    dfsLoc = resolver.current(loc)
    // Reset partial values from the failed city attempt.
    counts = { top3: 0, top10: 0, top20: 0, top100: 0 }
    organicTrafficRaw = 0
    failed = false
    result = await tryWith(dfsLoc)
  } else if (result.ok && "code" in dfsLoc) {
    resolver.recordCitySuccess(loc)
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

function buildCsv(rows: CompAnalysisLocationRows[]): string {
  const lines: string[] = []
  lines.push(
    "Website,Top 3,Top 10,Top 20,Top 100,Referring Domains,Pages Indexed,Organic Traffic",
  )
  for (const loc of rows) {
    lines.push(",,,,,,,")
    const label =
      loc.granularity === "state"
        ? `${loc.location} (state-level fallback)`
        : loc.location
    lines.push(`${csvEscape(label)},,,,,,,`)
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
    // Resolve city codes for every location up front so concurrent calls
    // don't all serialize on the locations-list cache miss.
    const resolver = new LocationResolver()
    await resolver.init(body.targetLocations)

    // Per-domain metrics (referring domains + pages indexed).
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

    // Per-(domain × location) metrics. Run partner FIRST per location so
    // the city/state probe lands before the competitors fan out — once
    // the partner row resolves a location to "state", the rest of the
    // domains for that location skip the city attempt.
    const partnerTasks = body.targetLocations.map((loc) => ({
      domain: partnerDomain,
      loc,
    }))
    const partnerResults = await mapWithConcurrency(partnerTasks, 3, (t) =>
      fetchLocationMetrics(t.domain, t.loc, resolver),
    )

    const competitorTasks: Array<{ domain: string; loc: typeof body.targetLocations[number] }> = []
    for (const domain of competitorDomains) {
      for (const loc of body.targetLocations) {
        competitorTasks.push({ domain, loc })
      }
    }
    const competitorResults = await mapWithConcurrency(competitorTasks, 5, (t) =>
      fetchLocationMetrics(t.domain, t.loc, resolver),
    )

    // Group by location, partner first, competitors sorted by Top 10 desc.
    const rows: CompAnalysisLocationRows[] = []
    for (let li = 0; li < body.targetLocations.length; li++) {
      const loc = body.targetLocations[li]
      const partnerLocM = partnerResults[li]
      const partnerRow = buildRow({
        domain: partnerDomain,
        isPartner: true,
        loc: partnerLocM,
        dm: domainMetrics.get(partnerDomain)!,
      })
      const competitorRows: CompAnalysisDomainRow[] = competitorDomains.map(
        (d, ci) => {
          const taskIdx = ci * body.targetLocations.length + li
          const m = competitorResults[taskIdx]
          return buildRow({
            domain: d,
            isPartner: false,
            loc: m,
            dm: domainMetrics.get(d)!,
          })
        },
      )
      competitorRows.sort((a, b) => b.top10 - a.top10)
      rows.push({
        location: `${loc.city}, ${loc.state}`,
        granularity: resolver.granularity(loc),
        domains: [partnerRow, ...competitorRows],
      })
    }

    // Roll up failures + state fallbacks into warnings.
    const stateLocations = rows.filter((r) => r.granularity === "state")
    if (stateLocations.length > 0) {
      const labels = stateLocations.map((r) => r.location).join(", ")
      warnings.push(
        `City-level data not available in DataForSEO for ${labels}; rolled up to state level for those locations.`,
      )
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
