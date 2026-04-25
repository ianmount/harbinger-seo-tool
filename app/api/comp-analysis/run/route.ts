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
 * Competitive Analysis endpoint — SERP-based methodology.
 *
 * For each (seed keyword × city), we query DataForSEO's SERP endpoint
 * with depth=100 and check whether each domain in the analysis (partner +
 * competitors) appears in the top 100 organic results, recording its best
 * rank. After all seeds for a city resolve, we aggregate per (domain ×
 * city) into Top 3 / 10 / 20 / 100 buckets — these are counts of seeds
 * the domain ranks for at each cutoff in that specific city.
 *
 * Numbers genuinely vary across cities because the underlying SERPs do.
 *
 * Per-domain metrics (referring domains, organic traffic at country
 * level, pages indexed at city level) are pulled separately and stay the
 * same shape as before.
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
   * The SERP endpoint accepts city-level Google Ads codes directly.
   */
  targetLocations: z.array(dfsLocationSchema).min(1).max(10),
  competitorUrls: z.array(z.string().min(3)).min(1).max(20),
  /**
   * Seed keywords the user explicitly approved. Each (seed × city) is a
   * SERP probe; cost scales linearly with this list, so the UI caps it
   * and shows an estimate before submission.
   */
  seedKeywords: z.array(z.string().min(1)).min(1).max(200),
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
 * Per-domain metrics: referring domains (location-independent) + organic
 * traffic at country level (Labs domain_rank_overview accepts country
 * codes only). Pages indexed is per-(domain × city) and lives in the
 * location loop below.
 */
async function fetchDomainMetrics(
  domain: string,
): Promise<DomainMetricsResult> {
  let referringDomains = 0
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
  return { referringDomains, organicTrafficRaw, failed, errors }
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
  // Methodology comment — # prefix is a widely understood CSV
  // convention (Excel, pandas all import it cleanly as a text row).
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
  pagesIndexed: number
  dm: DomainMetricsResult
  failed: boolean
}): CompAnalysisDomainRow {
  const { domain, isPartner, buckets, pagesIndexed, dm, failed } = params
  return {
    domain,
    isPartner,
    top3: buckets.top3,
    top10: buckets.top10,
    top20: buckets.top20,
    top100: buckets.top100,
    referringDomains: dm.referringDomains,
    pagesIndexed,
    organicTraffic: compactThousands(dm.organicTrafficRaw),
    organicTrafficRaw: dm.organicTrafficRaw,
    failed: failed || dm.failed,
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
    // 1. Per-domain metrics (referring domains + organic traffic at
    //    country level). One pass, location-independent.
    const domainMetrics = new Map<string, DomainMetricsResult>()
    const dmResults = await mapWithConcurrency(allDomains, 3, (d) =>
      fetchDomainMetrics(d),
    )
    for (let i = 0; i < allDomains.length; i++) {
      domainMetrics.set(allDomains[i], dmResults[i])
    }

    // 2. Per-(domain × city) pages indexed via site: SERP probe.
    const indexedTasks: Array<{ domain: string; locationIdx: number }> = []
    for (const domain of allDomains) {
      for (let li = 0; li < body.targetLocations.length; li++) {
        indexedTasks.push({ domain, locationIdx: li })
      }
    }
    const indexedResults = await mapWithConcurrency(
      indexedTasks,
      SERP_CONCURRENCY,
      async (t) => {
        try {
          return {
            value: await indexedPageCount(
              t.domain,
              body.targetLocations[t.locationIdx].location_code,
            ),
            error: null as string | null,
          }
        } catch (err) {
          const msg = `indexedPageCount(${t.domain}, loc=${body.targetLocations[t.locationIdx].location_code}): ${describeError(err)}`
          console.warn(`[api/comp-analysis] ${msg}`)
          return { value: 0, error: msg }
        }
      },
    )

    // 3. Per-(seed × city) SERP probes — the heart of the new
    //    methodology. concurrency capped at SERP_CONCURRENCY so a 40-seed
    //    × 3-city run doesn't fan out 120 simultaneous calls.
    const serpTasks: Array<{ seed: string; locationIdx: number }> = []
    for (const seed of seeds) {
      for (let li = 0; li < body.targetLocations.length; li++) {
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
        const loc = body.targetLocations[t.locationIdx]
        try {
          const hits = await serpRankedDomains(
            t.seed,
            { code: loc.location_code },
            { depth: 100 },
          )
          return { hits, error: null }
        } catch (err) {
          const msg = `serp("${t.seed}", loc=${loc.location_code} ${loc.location_name}): ${describeError(err)}`
          console.warn(`[api/comp-analysis] ${msg}`)
          return { hits: [], error: msg }
        }
      },
    )

    // Build a lookup: city index → seed → hits.
    const serpByCity: Array<Map<string, SerpRankedDomain[]>> =
      body.targetLocations.map(() => new Map())
    const serpErrors: Array<string[]> = body.targetLocations.map(() => [])
    for (let i = 0; i < serpTasks.length; i++) {
      const { seed, locationIdx } = serpTasks[i]
      const r = serpResults[i]
      serpByCity[locationIdx].set(seed, r.hits)
      if (r.error) serpErrors[locationIdx].push(r.error)
    }

    // 4. Aggregate Top 3/10/20/100 buckets per (domain × city) and build rows.
    const rows: CompAnalysisLocationRows[] = []
    for (let li = 0; li < body.targetLocations.length; li++) {
      const loc = body.targetLocations[li]

      const partnerBuckets = bucketize(
        partnerDomain,
        seeds,
        serpByCity[li],
      )
      const partnerIndexedIdx = indexedTasks.findIndex(
        (t) => t.domain === partnerDomain && t.locationIdx === li,
      )
      const partnerRow = buildRow({
        domain: partnerDomain,
        isPartner: true,
        buckets: partnerBuckets,
        pagesIndexed: indexedResults[partnerIndexedIdx]?.value ?? 0,
        dm: domainMetrics.get(partnerDomain)!,
        failed: indexedResults[partnerIndexedIdx]?.error != null,
      })

      const competitorRows: CompAnalysisDomainRow[] = competitorDomains.map(
        (d) => {
          const buckets = bucketize(d, seeds, serpByCity[li])
          const indexedIdx = indexedTasks.findIndex(
            (t) => t.domain === d && t.locationIdx === li,
          )
          return buildRow({
            domain: d,
            isPartner: false,
            buckets,
            pagesIndexed: indexedResults[indexedIdx]?.value ?? 0,
            dm: domainMetrics.get(d)!,
            failed: indexedResults[indexedIdx]?.error != null,
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

    // 5. Surface real per-call error messages so failed cells are explained.
    for (const [domain, dm] of domainMetrics) {
      for (const e of dm.errors) {
        warnings.push(`${domain} — ${e}`)
      }
    }
    for (let i = 0; i < indexedTasks.length; i++) {
      const r = indexedResults[i]
      if (r.error) {
        const t = indexedTasks[i]
        const loc = body.targetLocations[t.locationIdx]
        warnings.push(`${t.domain} @ ${loc.location_name} — ${r.error}`)
      }
    }
    for (let li = 0; li < body.targetLocations.length; li++) {
      const loc = body.targetLocations[li]
      const errs = Array.from(new Set(serpErrors[li]))
      for (const e of errs) {
        warnings.push(`${loc.location_name} — ${e}`)
      }
    }

    const csv = buildCsv(rows, seeds.length)
    const durationMs = Date.now() - startedAt
    console.log(
      `[api/comp-analysis/run] domains=${allDomains.length} cities=${body.targetLocations.length} seeds=${seeds.length} duration=${(durationMs / 1000).toFixed(1)}s warnings=${warnings.length}`,
    )

    return NextResponse.json({
      rows,
      csv,
      warnings,
      seedCount: seeds.length,
      estimatedSerpCost: seeds.length * body.targetLocations.length * SERP_COST_USD,
    })
  } catch (error) {
    console.error("[api/comp-analysis/run] failed:", error)
    const status = error instanceof DataForSEOError ? 502 : 500
    const message = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json({ error: message }, { status })
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
