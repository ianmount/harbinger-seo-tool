import "server-only"
import { z } from "zod"
import {
  bulkBacklinksByTarget,
  DFS_LABS_COUNTRY_CODE_US,
  domainRankOverview,
  referringDomainCount,
  serpRankedDomains,
  type SerpRankedDomain,
} from "@/lib/dataforseo"
import type { TaskRunner } from "@/lib/inngest/functions"
import {
  isCancelRequested,
  JobCancelledError,
  updateProgress,
} from "@/lib/jobs"
import type {
  CompAnalysisDomainRow,
  CompAnalysisLocationRows,
} from "@/lib/types"

/**
 * Competitive Analysis task. Lifted from /api/comp-analysis/run. SERP-based
 * methodology: per (seed × location), probe DataForSEO at depth=100 and
 * count how many seeds each domain ranks for in the top 3/10/20/100. Mix
 * with per-domain referring-domains / pages-indexed / organic-traffic
 * pulls (one per unique domain, country-level).
 */

const locationCompetitorsSchema = z.object({
  location: z.string().min(1),
  locationCode: z.number().int().positive(),
  competitors: z.array(z.string().min(3)).max(20),
})

export const CompAnalysisInputSchema = z.object({
  partnerUrl: z.string().min(3),
  seedKeywords: z.array(z.string().min(1)).min(1).max(400),
  locationCompetitors: z.array(locationCompetitorsSchema).min(1).max(10),
})

export type CompAnalysisInput = z.infer<typeof CompAnalysisInputSchema>

// One HTTP call per (seed × location) probe — DFS's
// /v3/serp/google/organic/live/advanced rejects multi-task arrays with
// "You can set only one task at a time", so live SERP can't be batched.
// SERP_CONCURRENCY governs parallelism inside one chunk; each chunk is its
// own Inngest step.run with its own ~800s Vercel budget. 30 stays under
// DFS's documented 2000 calls/min cap, and dfsRequest retries 429s with
// backoff. SERP_CHUNK_SIZE bounds both per-chunk wall-clock and the
// step.run output size (4MiB Inngest cap) — 100 probes × ~100 organic
// items × ~120 bytes ≈ 1.2 MB of returned JSON, well under cap.
const SERP_CONCURRENCY = 30
const SERP_CHUNK_SIZE = 100
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

function domainMatchesRoot(serpDomain: string, rootDomain: string): boolean {
  const s = serpDomain.toLowerCase().replace(/^www\./, "")
  const r = rootDomain.toLowerCase().replace(/^www\./, "")
  if (!s || !r) return false
  return s === r || s.endsWith("." + r)
}

function bestRank(hits: SerpRankedDomain[], targetDomain: string): number | null {
  let best: number | null = null
  for (const h of hits) {
    if (!domainMatchesRoot(h.domain, targetDomain)) continue
    if (best == null || h.rankAbsolute < best) best = h.rankAbsolute
  }
  return best
}

/**
 * Per-domain global metrics that don't vary by city. Organic traffic is
 * country-level (Labs domain_rank_overview only accepts country codes), and
 * the global referring-domain count is kept as a fallback for cells where
 * per-URL backlinks couldn't be resolved.
 */
interface DomainMetrics {
  /** Global referring-domain count from /v3/backlinks/summary/live. */
  referringDomainsGlobal: number
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

async function fetchDomainMetrics(domain: string): Promise<DomainMetricsResult> {
  let referringDomainsGlobal = 0
  let organicTrafficRaw = 0
  let failed = false
  const errors: string[] = []
  try {
    referringDomainsGlobal = await referringDomainCount(domain)
  } catch (err) {
    failed = true
    errors.push(`referringDomainCount(${domain}): ${describeError(err)}`)
  }
  try {
    const overview = await domainRankOverview(domain, {
      code: DFS_LABS_COUNTRY_CODE_US,
    })
    organicTrafficRaw = Math.round(overview.organicTraffic)
  } catch (err) {
    failed = true
    errors.push(
      `domainRankOverview(${domain}, country): ${describeError(err)}`,
    )
  }
  return { referringDomainsGlobal, organicTrafficRaw, failed, errors }
}

/**
 * Walk the SERP results for a given (domain × location) and collect the
 * distinct URLs from this domain that ranked in the top 100 for any seed
 * keyword. Numbers genuinely vary by city because SERPs do.
 */
function collectRankingUrls(
  domain: string,
  hitsBySeed: Map<string, SerpRankedDomain[]>,
): string[] {
  const urls = new Set<string>()
  for (const hits of hitsBySeed.values()) {
    for (const h of hits) {
      if (!domainMatchesRoot(h.domain, domain)) continue
      const u = h.url?.trim()
      if (!u) continue
      urls.add(u)
    }
  }
  return [...urls]
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
    `# Top 3/10/20/100 reflects how many of your ${seedCount} approved target keywords each domain ranks for in the specified city. "Pages Ranking" is the count of distinct URLs from that domain ranking in top 100 for any seed in that city. "Referring Domains" sums the referring-domain count across those ranking URLs (per-URL backlink data; the same referring domain pointing to multiple ranking URLs is counted once per URL). All three columns vary by city because rankings are measured against city-level Google SERPs.`,
  )
  lines.push(
    "Website,Top 3,Top 10,Top 20,Top 100,Referring Domains,Pages Ranking,Organic Traffic",
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
  rankingUrls: string[]
  perPageReferring: Map<string, { referringDomains: number }>
  dm: DomainMetricsResult
}): CompAnalysisDomainRow {
  const { domain, isPartner, buckets, rankingUrls, perPageReferring, dm } =
    params
  // Sum referring domains across this cell's ranking URLs. Falls back to
  // the global per-domain count when we have no ranking URLs (this domain
  // doesn't rank in this city) so the cell still shows a meaningful number
  // for context — flagged via `failed` if even the global call errored.
  let referringDomains = 0
  let resolvedAny = false
  for (const url of rankingUrls) {
    const m = perPageReferring.get(url)
    if (m) {
      referringDomains += m.referringDomains
      resolvedAny = true
    }
  }
  if (!resolvedAny) referringDomains = dm.referringDomainsGlobal
  return {
    domain,
    isPartner,
    top3: buckets.top3,
    top10: buckets.top10,
    top20: buckets.top20,
    top100: buckets.top100,
    referringDomains,
    pagesIndexed: rankingUrls.length,
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

export const runCompAnalysisTask: TaskRunner = async ({ jobId, job, step }) => {
  const parsed = CompAnalysisInputSchema.safeParse(job.input)
  if (!parsed.success) {
    throw new Error(
      `Invalid comp-analysis input: ${JSON.stringify(parsed.error.flatten())}`,
    )
  }
  const body = parsed.data

  // Cancellation checks happen inside each step.run — outside-step.run code
  // is replayed on every Inngest re-invocation and shouldn't have side
  // effects that depend on remote state.
  const checkCancel = async () => {
    if (await isCancelRequested(jobId)) throw new JobCancelledError(jobId)
  }

  const partnerDomain = cleanDomain(body.partnerUrl)

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
    throw new Error(
      "Every location must have at least one competitor. Add competitors per-location and run again.",
    )
  }

  const uniqueDomains = new Set<string>([partnerDomain])
  for (const lc of locationCompetitors) {
    for (const c of lc.competitors) uniqueDomains.add(c)
  }
  const uniqueDomainsList = [...uniqueDomains]

  const seeds = Array.from(
    new Set(
      body.seedKeywords
        .map((k) => k.trim())
        .filter((k) => k.length > 0)
        .map((k) => k.toLowerCase()),
    ),
  )
  if (seeds.length === 0) {
    throw new Error("At least one seed keyword is required.")
  }

  const warnings: string[] = []

  // 1. Domain-level metrics — one step.run for the whole phase.
  const dmResults = await step.run("domain-metrics", async () => {
    await checkCancel()
    await updateProgress(jobId, {
      stage: "Pulling domain metrics",
      detail: `${uniqueDomainsList.length} domains`,
    }).catch(() => {})
    return await mapWithConcurrency(uniqueDomainsList, 3, (d) =>
      fetchDomainMetrics(d),
    )
  })
  const domainMetrics = new Map<string, DomainMetricsResult>()
  for (let i = 0; i < uniqueDomainsList.length; i++) {
    domainMetrics.set(uniqueDomainsList[i], dmResults[i])
  }

  // 2. SERP probes — chunked across multiple step.run blocks. Inngest
  // re-invokes the function across step boundaries, so cumulative SERP
  // wall-clock can exceed the 800s Vercel ceiling. Each chunk's body must
  // still finish within 800s, but at SERP_CHUNK_SIZE=100 with concurrency
  // 30 that's ~4 sequential rounds × ~5-15s ≈ a minute or two per chunk.
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
  const chunkCount = Math.max(1, Math.ceil(serpTasks.length / SERP_CHUNK_SIZE))
  const serpResults: SerpProbeResult[] = []
  for (let ci = 0; ci < chunkCount; ci++) {
    const chunkProbes = serpTasks.slice(
      ci * SERP_CHUNK_SIZE,
      (ci + 1) * SERP_CHUNK_SIZE,
    )
    const chunkResults = await step.run(
      `serp-chunk-${ci}`,
      async (): Promise<SerpProbeResult[]> => {
        await checkCancel()
        await updateProgress(jobId, {
          stage: "Probing SERPs",
          detail: `chunk ${ci + 1}/${chunkCount} (${seeds.length} seeds × ${locationCompetitors.length} locations)`,
        }).catch(() => {})
        return await mapWithConcurrency(
          chunkProbes,
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
              return { hits: [], error: msg }
            }
          },
        )
      },
    )
    serpResults.push(...chunkResults)
  }

  const serpByLocation: Array<Map<string, SerpRankedDomain[]>> =
    locationCompetitors.map(() => new Map())
  const serpErrors: Array<string[]> = locationCompetitors.map(() => [])
  for (let i = 0; i < serpTasks.length; i++) {
    const { seed, locationIdx } = serpTasks[i]
    const r = serpResults[i]
    serpByLocation[locationIdx].set(seed, r.hits)
    if (r.error) serpErrors[locationIdx].push(r.error)
  }

  // 3. Per-(domain × location) ranking URL collection. Falls out of the
  // SERP probes for free — every organic SERP item carries a `url`, so we
  // already have the data we need to compute "pages on this domain that
  // rank in this city" without paying for additional API calls.
  const rankingUrlsByCell = new Map<string, string[]>()
  const allRankingUrls = new Set<string>()
  const cellKey = (li: number, d: string): string => `${li}::${d}`
  for (let li = 0; li < locationCompetitors.length; li++) {
    const lc = locationCompetitors[li]
    const cellDomains = [partnerDomain, ...lc.competitors]
    for (const d of cellDomains) {
      const urls = collectRankingUrls(d, serpByLocation[li])
      rankingUrlsByCell.set(cellKey(li, d), urls)
      for (const u of urls) allRankingUrls.add(u)
    }
  }

  // 4. Bulk per-URL backlinks lookup. One DFS call (chunks of 1000) covers
  // every ranking URL across every cell, so cost stays in the cents range
  // even when the keyword × city matrix is large.
  const rankingUrlList = [...allRankingUrls]
  const backlinksOutcome = await step.run(
    "bulk-backlinks",
    async (): Promise<{
      entries: Array<[string, { referringDomains: number; backlinks: number }]>
      warning: string | null
    }> => {
      await checkCancel()
      await updateProgress(jobId, {
        stage: "Pulling per-URL backlinks",
        detail: `${rankingUrlList.length} ranking URL${rankingUrlList.length === 1 ? "" : "s"}`,
      }).catch(() => {})
      if (rankingUrlList.length === 0) return { entries: [], warning: null }
      try {
        const map = await bulkBacklinksByTarget(rankingUrlList)
        return { entries: [...map.entries()], warning: null }
      } catch (err) {
        return {
          entries: [],
          warning: `bulk_backlinks lookup failed: ${describeError(err)} — falling back to global per-domain referring counts.`,
        }
      }
    },
  )
  const perUrlBacklinks = new Map<
    string,
    { referringDomains: number; backlinks: number }
  >(backlinksOutcome.entries)
  if (backlinksOutcome.warning) warnings.push(backlinksOutcome.warning)

  await updateProgress(jobId, { stage: "Building rows" }).catch(() => {})

  // 5. Build rows.
  const rows: CompAnalysisLocationRows[] = []
  for (let li = 0; li < locationCompetitors.length; li++) {
    const lc = locationCompetitors[li]
    const partnerRow = buildRow({
      domain: partnerDomain,
      isPartner: true,
      buckets: bucketize(partnerDomain, seeds, serpByLocation[li]),
      rankingUrls: rankingUrlsByCell.get(cellKey(li, partnerDomain)) ?? [],
      perPageReferring: perUrlBacklinks,
      dm: domainMetrics.get(partnerDomain)!,
    })
    const competitorRows: CompAnalysisDomainRow[] = lc.competitors.map((d) =>
      buildRow({
        domain: d,
        isPartner: false,
        buckets: bucketize(d, seeds, serpByLocation[li]),
        rankingUrls: rankingUrlsByCell.get(cellKey(li, d)) ?? [],
        perPageReferring: perUrlBacklinks,
        dm: domainMetrics.get(d)!,
      }),
    )
    competitorRows.sort((a, b) => b.top10 - a.top10)
    rows.push({
      location: lc.location,
      locationCode: lc.locationCode,
      locationType: "",
      domains: [partnerRow, ...competitorRows],
    })
  }

  for (const [domain, dm] of domainMetrics) {
    for (const e of dm.errors) warnings.push(`${domain} — ${e}`)
  }
  for (let li = 0; li < locationCompetitors.length; li++) {
    const lc = locationCompetitors[li]
    const errs = Array.from(new Set(serpErrors[li]))
    for (const e of errs) warnings.push(`${lc.location} — ${e}`)
  }

  const csv = buildCsv(rows, seeds.length)

  return {
    result: {
      rows,
      csv,
      warnings,
      seedCount: seeds.length,
      estimatedSerpCost:
        seeds.length * locationCompetitors.length * SERP_COST_USD,
    },
    resultPath: `/comp-analysis?job=${jobId}`,
  }
}
