import { NextResponse } from "next/server"
import { z } from "zod"
import {
  DataForSEOError,
  DFS_LABS_COUNTRY_CODE_US,
  domainRankOverview,
  indexedPageCount,
  referringDomainCount,
  serpRankedDomains,
  type SerpRankedDomain,
} from "@/lib/dataforseo"
import type {
  CompAnalysisDomainRow,
  CompAnalysisLocationRows,
} from "@/lib/types"

/**
 * Competitive Analysis endpoint — SERP-based methodology, per-location
 * competitor lists.
 *
 * For each (seed × location) we query DataForSEO's SERP at depth=100 and
 * record each result domain's rank_absolute. After all probes for a
 * location resolve we count, per (domain × location), how many seeds
 * the domain ranks for at top 3 / 10 / 20 / 100 — using ONLY that
 * location's configured competitor list (plus the partner, which
 * appears in every location).
 *
 * Domain-level metrics — Referring Domains, Pages Indexed, Organic
 * Traffic — are pulled once per unique domain across the whole request
 * (deduplicated across all locations) and reused for every row that
 * domain appears in. Pages Indexed uses location_code 2840 (US) so the
 * value is consistent regardless of which city a row belongs to.
 *
 * No GSC/GA4 — DataForSEO only.
 */
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

const locationCompetitorsSchema = z.object({
  /** Display label — used for UI and CSV row headers. */
  location: z.string().min(1),
  /** DataForSEO Labs location code, primary key for SERP lookups. */
  locationCode: z.number().int().positive(),
  competitors: z.array(z.string().min(3)).max(20),
})

const bodySchema = z.object({
  partnerUrl: z.string().min(3),
  /** User-approved seed keywords; one SERP probe per (seed × location). */
  seedKeywords: z.array(z.string().min(1)).min(1).max(200),
  /**
   * Per-location competitor lists. Locations are evaluated in the order
   * supplied; the resulting `rows` array preserves that order.
   */
  locationCompetitors: z.array(locationCompetitorsSchema).min(1).max(10),
})

type Body = z.infer<typeof bodySchema>

const SERP_CONCURRENCY = 5
/** Approximate cost of `serp/google/organic/live/advanced` per call, USD. */
const SERP_COST_USD = 0.002

function cleanDomain(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/.*$/, "")
    .toLowerCase()
}

function compactThousands(n: number): string {
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`
  }
  return String(Math.round(n))
}

/**
 * Match a SERP-returned domain to one of the analysis target domains.
 * Treats the target as a "root" — any subdomain match counts. So
 * "blog.example.com" returned from SERP matches target "example.com",
 * but "fakeexample.com" does not (boundary check via the leading dot).
 */
function domainMatchesRoot(serpDomain: string, rootDomain: string): boolean {
  const s = serpDomain.toLowerCase().replace(/^www\./, "")
  const r = rootDomain.toLowerCase().replace(/^www\./, "")
  if (!s || !r) return false
  return s === r || s.endsWith("." + r)
}

/** Lowest rank_absolute at which `targetDomain` appears in the result list. */
function bestRank(hits: SerpRankedDomain[], targetDomain: string): number | null {
  let best: number | null = null
  for (const h of hits) {
    if (!domainMatchesRoot(h.domain, targetDomain)) continue
    if (best == null || h.rankAbsolute < best) best = h.rankAbsolute
  }
  return best
}

interface DomainMetrics {
  referringDomains: number
  pagesIndexed: number
  organicTrafficRaw: number
}

interface DomainMetricsResult extends DomainMetrics {
  failed?: boolean
  errors: string[]
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message.length > 220
      ? `${err.message.slice(0, 217)}…`
      : err.message
  }
  return String(err)
}

/**
 * Per-domain metrics, all pulled at country level so the same value is
 * reported across every location row for a given domain. One call per
 * domain per metric — no per-(domain × city) fan-out.
 */
async function fetchDomainMetrics(
  domain: string,
): Promise<DomainMetricsResult> {
  let referringDomains = 0
  let pagesIndexed = 0
  let organicTrafficRaw = 0
  let failed = false
  const errors: string[] = []
  try {
    referringDomains = await referringDomainCount(domain)
  } catch (err) {
    failed = true
    const msg = `referringDomainCount(${domain}): ${describeError(err)}`
    errors.push(msg)
    console.warn(`[api/comp-analysis] ${msg}`)
  }
  try {
    pagesIndexed = await indexedPageCount(domain, DFS_LABS_COUNTRY_CODE_US)
  } catch (err) {
    failed = true
    const msg = `indexedPageCount(${domain}, country): ${describeError(err)}`
    errors.push(msg)
    console.warn(`[api/comp-analysis] ${msg}`)
  }
  try {
    const overview = await domainRankOverview(domain, {
      code: DFS_LABS_COUNTRY_CODE_US,
    })
    organicTrafficRaw = Math.round(overview.organicTraffic)
  } catch (err) {
    failed = true
    const msg = `domainRankOverview(${domain}, country): ${describeError(err)}`
    errors.push(msg)
    console.warn(`[api/comp-analysis] ${msg}`)
  }
  return {
    referringDomains,
    pagesIndexed,
    organicTrafficRaw,
    failed,
    errors,
  }
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

function buildCsv(
  rows: CompAnalysisLocationRows[],
  seedCount: number,
): string {
  const lines: string[] = []
  lines.push(
    `# Top 3/10/20/100 reflects how many of your ${seedCount} approved target keywords each domain ranks for in the specified city. Numbers vary by city because rankings are measured against city-level Google SERPs.`,
  )
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
  buckets: { top3: number; top10: number; top20: number; top100: number }
  dm: DomainMetricsResult
}): CompAnalysisDomainRow {
  const { domain, isPartner, buckets, dm } = params
  return {
    domain,
    isPartner,
    top3: buckets.top3,
    top10: buckets.top10,
    top20: buckets.top20,
    top100: buckets.top100,
    referringDomains: dm.referringDomains,
    pagesIndexed: dm.pagesIndexed,
    organicTraffic: compactThousands(dm.organicTrafficRaw),
    organicTrafficRaw: dm.organicTrafficRaw,
    failed: dm.failed,
  }
}

function bucketize(
  domain: string,
  seeds: string[],
  hitsBySeed: Map<string, SerpRankedDomain[]>,
): { top3: number; top10: number; top20: number; top100: number } {
  let top3 = 0
  let top10 = 0
  let top20 = 0
  let top100 = 0
  for (const seed of seeds) {
    const hits = hitsBySeed.get(seed)
    if (!hits || hits.length === 0) continue
    const rank = bestRank(hits, domain)
    if (rank == null) continue
    if (rank <= 3) top3++
    if (rank <= 10) top10++
    if (rank <= 20) top20++
    if (rank <= 100) top100++
  }
  return { top3, top10, top20, top100 }
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

  // Normalize each location's competitor list once; preserve user order
  // within a location, drop the partner if it accidentally appears, dedupe.
  const locationCompetitors = body.locationCompetitors.map((lc) => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const c of lc.competitors) {
      const cd = cleanDomain(c)
      if (!cd || cd === partnerDomain || seen.has(cd)) continue
      seen.add(cd)
      out.push(cd)
    }
    return { ...lc, competitors: out }
  })

  if (locationCompetitors.some((lc) => lc.competitors.length === 0)) {
    return NextResponse.json(
      {
        error:
          "Every location must have at least one competitor. Add competitors per-location and run again.",
      },
      { status: 400 },
    )
  }

  // Deduplicated set of every unique domain in the request — this is what
  // we pull domain-level metrics for. Partner is always included.
  const uniqueDomains = new Set<string>([partnerDomain])
  for (const lc of locationCompetitors) {
    for (const c of lc.competitors) uniqueDomains.add(c)
  }
  const uniqueDomainsList = [...uniqueDomains]

  // Dedupe seeds (lowercase) to avoid double-counting if the user pasted
  // the same keyword twice via different cases.
  const seeds = Array.from(
    new Set(
      body.seedKeywords
        .map((k) => k.trim())
        .filter((k) => k.length > 0)
        .map((k) => k.toLowerCase()),
    ),
  )
  if (seeds.length === 0) {
    return NextResponse.json(
      { error: "At least one seed keyword is required." },
      { status: 400 },
    )
  }

  const warnings: string[] = []
  const startedAt = Date.now()

  try {
    // 1. Domain-level metrics — once per unique domain. Cached in a Map so
    //    the same value is reused across every location row for that domain.
    const domainMetrics = new Map<string, DomainMetricsResult>()
    const dmResults = await mapWithConcurrency(uniqueDomainsList, 3, (d) =>
      fetchDomainMetrics(d),
    )
    for (let i = 0; i < uniqueDomainsList.length; i++) {
      domainMetrics.set(uniqueDomainsList[i], dmResults[i])
    }

    // 2. SERP probes — one per (seed × location). The probe doesn't care
    //    which competitors the user chose for a location; it returns the
    //    top-100 domains. We extract per-domain ranks from the cached hit
    //    list when building rows.
    const serpTasks: Array<{ seed: string; locationIdx: number }> = []
    for (const seed of seeds) {
      for (let li = 0; li < locationCompetitors.length; li++) {
        serpTasks.push({ seed, locationIdx: li })
      }
    }
    interface SerpProbeResult {
      hits: SerpRankedDomain[]
      error: string | null
    }
    const serpResults = await mapWithConcurrency(
      serpTasks,
      SERP_CONCURRENCY,
      async (t): Promise<SerpProbeResult> => {
        const lc = locationCompetitors[t.locationIdx]
        try {
          const hits = await serpRankedDomains(
            t.seed,
            { code: lc.locationCode },
            { depth: 100 },
          )
          return { hits, error: null }
        } catch (err) {
          const msg = `serp("${t.seed}", loc=${lc.locationCode} ${lc.location}): ${describeError(err)}`
          console.warn(`[api/comp-analysis] ${msg}`)
          return { hits: [], error: msg }
        }
      },
    )

    const serpByLocation: Array<Map<string, SerpRankedDomain[]>> =
      locationCompetitors.map(() => new Map())
    const serpErrors: Array<string[]> = locationCompetitors.map(() => [])
    for (let i = 0; i < serpTasks.length; i++) {
      const { seed, locationIdx } = serpTasks[i]
      const r = serpResults[i]
      serpByLocation[locationIdx].set(seed, r.hits)
      if (r.error) serpErrors[locationIdx].push(r.error)
    }

    // 3. Build rows. Per-location competitor sets differ: a domain that's
    //    a competitor in Sarasota but not Bradenton appears in the
    //    Sarasota section only.
    const rows: CompAnalysisLocationRows[] = []
    for (let li = 0; li < locationCompetitors.length; li++) {
      const lc = locationCompetitors[li]
      const partnerRow = buildRow({
        domain: partnerDomain,
        isPartner: true,
        buckets: bucketize(partnerDomain, seeds, serpByLocation[li]),
        dm: domainMetrics.get(partnerDomain)!,
      })
      const competitorRows: CompAnalysisDomainRow[] = lc.competitors.map(
        (d) =>
          buildRow({
            domain: d,
            isPartner: false,
            buckets: bucketize(d, seeds, serpByLocation[li]),
            dm: domainMetrics.get(d)!,
          }),
      )
      competitorRows.sort((a, b) => b.top10 - a.top10)
      rows.push({
        location: lc.location,
        locationCode: lc.locationCode,
        // We don't have location_type here (it lives on the DfsLabsLocation);
        // omit and let the UI derive it from compDfsLocations if needed.
        locationType: "",
        domains: [partnerRow, ...competitorRows],
      })
    }

    for (const [domain, dm] of domainMetrics) {
      for (const e of dm.errors) {
        warnings.push(`${domain} — ${e}`)
      }
    }
    for (let li = 0; li < locationCompetitors.length; li++) {
      const lc = locationCompetitors[li]
      const errs = Array.from(new Set(serpErrors[li]))
      for (const e of errs) {
        warnings.push(`${lc.location} — ${e}`)
      }
    }

    const csv = buildCsv(rows, seeds.length)
    const durationMs = Date.now() - startedAt
    console.log(
      `[api/comp-analysis/run] uniqueDomains=${uniqueDomainsList.length} cities=${locationCompetitors.length} seeds=${seeds.length} duration=${(durationMs / 1000).toFixed(1)}s warnings=${warnings.length}`,
    )

    return NextResponse.json({
      rows,
      csv,
      warnings,
      seedCount: seeds.length,
      estimatedSerpCost: seeds.length * locationCompetitors.length * SERP_COST_USD,
    })
  } catch (error) {
    console.error("[api/comp-analysis/run] failed:", error)
    const status = error instanceof DataForSEOError ? 502 : 500
    const message = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json({ error: message }, { status })
  }
}
