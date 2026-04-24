import { NextResponse } from "next/server"
import { z } from "zod"
import {
  DataForSEOError,
  domainRankOverview,
  rankedKeywords,
  serpCompetitors,
} from "@/lib/dataforseo"
import type {
  CompetitiveReport,
  CompetitiveRow,
  TargetMarket,
} from "@/lib/types"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const targetMarketSchema = z.object({
  city: z.string().min(1),
  state: z.string().min(1),
})

const bodySchema = z.object({
  prospectDomain: z.string().min(3),
  /** 0-5 competitor domains. Empty array triggers auto-suggestion. */
  competitors: z.array(z.string().min(3)).max(5),
  targetMarkets: z.array(targetMarketSchema).min(1).max(5),
  /**
   * Seed service keywords used only when `competitors` is empty, to drive the
   * SERP lookup that proposes competitors. E.g. ["plumber", "drain cleaning"].
   */
  seedServices: z.array(z.string().min(2)).max(5).optional(),
})

type Body = z.infer<typeof bodySchema>

/**
 * DataForSEO Labs location resolution.
 *
 * Labs endpoints only reliably accept country- and state-level location
 * identifiers — city-level codes that exist in Google Ads' taxonomy are
 * often rejected at the Labs layer with status 40501 (documented in
 * `lib/dataforseo.ts`). We therefore run the competitive comparison at
 * state granularity: every city in a given state collapses to one API
 * call per (domain, state) pair. The PDF still LABELS each row with the
 * original city-level market the MD entered — it's just the DFS lookup
 * that rolls up to state.
 */
function marketToDfsLocation(market: TargetMarket): {
  name: string
  displayLocationCode: number
} {
  // Normalize to proper casing DFS expects: "Georgia,United States".
  const state = market.state.trim()
  return {
    name: `${state},United States`,
    // We don't need the numeric code for the request; record 0 as a stub.
    displayLocationCode: 0,
  }
}

/** Deduplicate target markets by state — avoids duplicate DFS calls. */
function uniqueStates(markets: TargetMarket[]): TargetMarket[] {
  const seen = new Set<string>()
  const out: TargetMarket[] = []
  for (const m of markets) {
    const key = m.state.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(m)
  }
  return out
}

/**
 * Propose competitor domains when the MD left the field blank. Runs each
 * seed service query in each target state; aggregates the top 5 organic
 * result domains weighted by recurrence across queries. Excludes the
 * prospect's own domain.
 */
async function proposeCompetitors(params: {
  prospectDomain: string
  markets: TargetMarket[]
  seedServices: string[]
}): Promise<string[]> {
  const { prospectDomain, markets, seedServices } = params
  const seeds = seedServices.length > 0 ? seedServices.slice(0, 3) : []
  if (seeds.length === 0) return []
  const states = uniqueStates(markets)
  const tally = new Map<string, number>()
  const prospectHost = prospectDomain.toLowerCase()

  await Promise.all(
    seeds.flatMap((seed) =>
      states.map(async (state) => {
        const location = marketToDfsLocation(state)
        try {
          const domains = await serpCompetitors(seed, { name: location.name })
          for (const domain of domains.slice(0, 10)) {
            if (domain === prospectHost) continue
            tally.set(domain, (tally.get(domain) ?? 0) + 1)
          }
        } catch (err) {
          console.warn(
            `[api/audit/competitive] serpCompetitors failed for ${seed} ${location.name}:`,
            err,
          )
        }
      }),
    ),
  )

  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([domain]) => domain)
}

async function buildRow(
  domain: string,
  isProspect: boolean,
  markets: TargetMarket[],
): Promise<CompetitiveRow> {
  const perMarket = await Promise.all(
    markets.map(async (market) => {
      const location = marketToDfsLocation(market)
      try {
        const [overview, keywords] = await Promise.all([
          domainRankOverview(domain, { name: location.name }),
          rankedKeywords(domain, { name: location.name }, { limit: 25 }),
        ])
        const topKeywords = keywords
          .slice(0, 3)
          .map((k) => ({
            keyword: k.keyword,
            position: k.position,
            searchVolume: k.searchVolume,
          }))
        return {
          city: market.city,
          state: market.state,
          locationCode: overview.locationCode,
          organicKeywords: overview.organicKeywords,
          organicTraffic: overview.organicTraffic,
          organicTrafficCost: overview.organicTrafficCost,
          topKeywords,
        }
      } catch (err) {
        console.warn(
          `[api/audit/competitive] overview failed for ${domain} ${market.city},${market.state}:`,
          err,
        )
        return {
          city: market.city,
          state: market.state,
          locationCode: 0,
          organicKeywords: 0,
          organicTraffic: 0,
          organicTrafficCost: 0,
          topKeywords: [],
        }
      }
    }),
  )
  return { domain, isProspect, markets: perMarket }
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

  try {
    let competitors = body.competitors.slice()
    let competitorsAutoSuggested = false
    if (competitors.length === 0) {
      competitors = await proposeCompetitors({
        prospectDomain: body.prospectDomain,
        markets: body.targetMarkets,
        seedServices: body.seedServices ?? [],
      })
      competitorsAutoSuggested = true
    }

    const rows: CompetitiveRow[] = []
    rows.push(await buildRow(body.prospectDomain, true, body.targetMarkets))
    for (const c of competitors) {
      rows.push(await buildRow(c, false, body.targetMarkets))
    }

    const report: CompetitiveReport = {
      prospectDomain: body.prospectDomain,
      markets: body.targetMarkets,
      rows,
      competitorsAutoSuggested,
    }
    return NextResponse.json({ report })
  } catch (error) {
    console.error("[api/audit/competitive] failed:", error)
    const status = error instanceof DataForSEOError ? 502 : 500
    const message = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json({ error: message }, { status })
  }
}
