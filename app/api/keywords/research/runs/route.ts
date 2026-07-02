import { NextResponse } from "next/server"
import { z } from "zod"
import { deriveSessionId } from "@/lib/jobs"
import {
  createRun,
  listRunsForSession,
} from "@/lib/keyword-research-runs"
import { proposeSeeds, seedsFromServices } from "@/lib/keyword-research/seeds"
import type { KeywordResearchConfig, KeywordResearchLocation } from "@/lib/types"

export const maxDuration = 120

// Cities arrive already resolved to a DataForSEO location (the form's city
// picker hits /api/dataforseo/locations), so we trust the code the user
// picked rather than re-resolving a freeform string. That keeps the run
// synced to real DFSEO city codes.
const CitySchema = z.object({
  location_code: z.number().int().positive(),
  location_name: z.string().trim().min(1).max(160),
})

const CreateSchema = z.object({
  domain: z.string().trim().min(3).max(200),
  // No upper bound on the number of services (or their length): the SEO
  // engineer may paste a long real-world service list. Still require at least
  // one non-empty service so the seed pipeline has something to work with.
  services: z.array(z.string().trim().min(1)).min(1),
  cities: z.array(CitySchema).min(1).max(10),
  excludeServices: z.array(z.string().trim().min(1).max(160)).max(25).optional(),
  // When false, skip the Claude seed expansion and use the provided services
  // verbatim as seeds. Defaults to true (Claude expansion) for back-compat.
  useClaudeSeeds: z.boolean().optional(),
  depth: z.number().int().min(20).max(300).optional(),
  targetPlanSize: z.number().int().min(20).max(1000).optional(),
  extraAllow: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
  disableCategories: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
})

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/,?\s*united states$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/** "Atlanta,Georgia,United States" → "Atlanta, Georgia" for display. */
function cleanLabel(name: string): string {
  return name
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && s.toLowerCase() !== "united states")
    .join(", ")
}

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

  // Build locations directly from the picked DFSEO codes (deduped by code).
  const seenCodes = new Set<number>()
  const locations: KeywordResearchLocation[] = []
  for (const c of input.cities) {
    if (seenCodes.has(c.location_code)) continue
    seenCodes.add(c.location_code)
    locations.push({
      slug: slugify(c.location_name),
      label: cleanLabel(c.location_name),
      dfs: c.location_name,
      locationCode: c.location_code,
    })
  }

  const config: KeywordResearchConfig = {
    depth: input.depth ?? 100,
    targetPlanSize: input.targetPlanSize ?? 400,
    market: deriveMarket(locations, input.extraAllow ?? []),
    competitors: [],
    excludeServices: input.excludeServices ?? [],
    disableCategories: input.disableCategories ?? [],
  }

  // Seeds: either Claude expansion (default) or the provided services verbatim.
  // Both attach the national-volume probe and feed the identical review →
  // generation → curation pipeline downstream.
  let seedProposal
  try {
    seedProposal =
      input.useClaudeSeeds === false
        ? await seedsFromServices(input.services, {
            excludeServices: config.excludeServices,
          })
        : await proposeSeeds(input.domain, input.services, {
            excludeServices: config.excludeServices,
          })
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
    locations,
    seedProposal,
  })

  return NextResponse.json({ run })
}

export async function GET(): Promise<Response> {
  const sessionId = await deriveSessionId()
  const runs = await listRunsForSession(sessionId)
  return NextResponse.json({ runs }, { headers: { "Cache-Control": "no-store" } })
}

