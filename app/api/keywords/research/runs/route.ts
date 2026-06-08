import { NextResponse } from "next/server"
import { z } from "zod"
import { resolveCityLocations } from "@/lib/dataforseo"
import { deriveSessionId } from "@/lib/jobs"
import {
  createRun,
  listRunsForSession,
} from "@/lib/keyword-research-runs"
import { proposeSeeds } from "@/lib/keyword-research/seeds"
import type { KeywordResearchConfig, KeywordResearchLocation } from "@/lib/types"

export const maxDuration = 120

const CreateSchema = z.object({
  domain: z.string().trim().min(3).max(200),
  services: z.array(z.string().trim().min(1).max(160)).min(1).max(25),
  cities: z.array(z.string().trim().min(1).max(120)).min(1).max(10),
  depth: z.number().int().min(20).max(300).optional(),
  targetPlanSize: z.number().int().min(20).max(1000).optional(),
  competitors: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  extraAllow: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
  disableCategories: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
})

/** Derive the geo allowlist (cities + states) from resolved DFS locations. */
function deriveMarket(
  locations: KeywordResearchLocation[],
  extraAllow: string[],
): KeywordResearchConfig["market"] {
  const cities = new Set<string>()
  const states = new Set<string>()
  for (const loc of locations) {
    // dfs = "City,Region,Country"
    const segs = loc.dfs.split(",").map((s) => s.trim())
    if (segs[0]) cities.add(segs[0])
    if (segs[1]) states.add(segs[1])
  }
  return {
    cities: [...cities],
    states: [...states],
    extraAllow,
  }
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 })
  }
  const parsed = CreateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", issues: parsed.error.flatten() },
      { status: 400 },
    )
  }
  const input = parsed.data

  const sessionId = await deriveSessionId()

  // Resolve cities → DFS Google Ads locations. Stop and ask on any
  // unresolved input (guardrail: never silently fall back to national).
  let resolved: { resolved: KeywordResearchLocation[]; unresolved: string[] }
  try {
    resolved = await resolveCityLocations(input.cities)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json(
      { error: `Location lookup failed: ${msg}` },
      { status: 502 },
    )
  }
  if (resolved.unresolved.length > 0) {
    return NextResponse.json(
      {
        error: "unresolved_locations",
        unresolved: resolved.unresolved,
        message: `Could not resolve to a DataForSEO city: ${resolved.unresolved.join(
          ", ",
        )}. Try "City, ST" (e.g. "Atlanta, GA").`,
      },
      { status: 400 },
    )
  }

  const config: KeywordResearchConfig = {
    depth: input.depth ?? 100,
    targetPlanSize: input.targetPlanSize ?? 400,
    market: deriveMarket(resolved.resolved, input.extraAllow ?? []),
    competitors: input.competitors ?? [],
    disableCategories: input.disableCategories ?? [],
  }

  // Propose seeds (Claude) + national volume probe.
  let seedProposal
  try {
    seedProposal = await proposeSeeds(input.domain, input.services)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json(
      { error: `Seed proposal failed: ${msg}` },
      { status: 502 },
    )
  }

  const run = await createRun({
    sessionId,
    domain: input.domain.trim(),
    services: input.services,
    config,
    locations: resolved.resolved,
    seedProposal,
  })

  return NextResponse.json({ run })
}

export async function GET(): Promise<Response> {
  const sessionId = await deriveSessionId()
  const runs = await listRunsForSession(sessionId)
  return NextResponse.json({ runs }, { headers: { "Cache-Control": "no-store" } })
}
