import "server-only"
import { z } from "zod"
import { callClaude, ClaudeApiError } from "@/lib/claude"
import { DFS_LABS_COUNTRY_CODE_US, searchVolume } from "@/lib/dataforseo"
import type { DfsLocation, SeedProposalGroup } from "@/lib/types"

/**
 * Step 1 of the keyword-research flow: translate the business's services into
 * search-aligned seeds, then ground them with a cheap national volume probe
 * so the user approves seeds with evidence.
 *
 * Mirrors the skill's Step 1: Claude drafts 2-4 seeds per service (strip
 * branding, plain head terms, real searcher phrasings), then we attach the
 * national search volume of each seed phrase from a single Google Ads
 * search_volume call (the cheap "data probe"). The user edits/approves the
 * result before any paid generation runs.
 */

const SEED_MODEL = "claude-sonnet-4-6"
const COUNTRY_LOC: DfsLocation = { code: DFS_LABS_COUNTRY_CODE_US }

const claudeSeedSchema = z.object({
  groups: z
    .array(
      z.object({
        service: z.string().trim().min(1),
        seeds: z.array(z.string().trim().min(1)).min(1).max(6),
      }),
    )
    .min(1),
})

function stripCodeFences(text: string): string {
  const t = text.trim()
  const m = t.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i)
  return m ? m[1].trim() : t
}

function extractJsonObject(text: string): string {
  const stripped = stripCodeFences(text)
  const first = stripped.indexOf("{")
  const last = stripped.lastIndexOf("}")
  if (first === -1 || last === -1 || last <= first) return stripped
  return stripped.slice(first, last + 1)
}

export interface ProposeSeedsOptions {
  /** Services/topics Claude must NOT propose seeds for. */
  excludeServices?: string[]
  /** Free-text revision instructions from the user (regeneration). */
  instructions?: string
}

function buildPrompt(
  domain: string,
  services: string[],
  opts: ProposeSeedsOptions,
): { system: string; prompt: string } {
  const system =
    "You are an SEO strategist building keyword seeds for a local service business. Seeds are short head phrases that customers actually search and that DataForSEO's keyword_suggestions can anchor to. Return only the JSON the schema asks for — no markdown, no commentary."
  const lines: string[] = []
  lines.push(`# Task`)
  lines.push(
    `For the business at "${domain}", translate each service below into 2-4 search-aligned seeds.`,
  )
  lines.push("")
  lines.push(`## Rules`)
  lines.push(`- Strip branding/marketing language ("Crystal-Clear Weekly Pool Care" → "pool cleaning", "pool service", "pool maintenance").`)
  lines.push(`- Use plain head terms and the synonyms/phrasings real searchers use.`)
  lines.push(`- Keep seeds at phrase level — not a single broad noun like "pool" (too noisy), not a full long-tail query (too narrow for expansion).`)
  lines.push(`- Dedupe seeds that collapse across services.`)
  const exclusions = (opts.excludeServices ?? [])
    .map((s) => s.trim())
    .filter(Boolean)
  if (exclusions.length > 0) {
    lines.push(
      `- DO NOT propose seeds for these excluded services/topics (skip them entirely, and avoid seeds that would surface them): ${exclusions.join("; ")}.`,
    )
  }
  lines.push("")
  lines.push(`## Services`)
  for (const s of services) lines.push(`- ${s}`)
  const instructions = (opts.instructions ?? "").trim()
  if (instructions) {
    lines.push("")
    lines.push(`## Additional instructions from the user (apply these)`)
    lines.push(instructions)
  }
  lines.push("")
  lines.push(`## Output`)
  lines.push(
    `Return one JSON object: { "groups": [ { "service": "<service as given>", "seeds": ["seed 1", "seed 2", ...] }, ... ] }.`,
  )
  return { system, prompt: lines.join("\n") }
}

/**
 * Propose seeds for the given services and attach a national-volume probe to
 * each. Throws on Claude failure; the volume probe is best-effort (a failed
 * probe just leaves nationalVolume null).
 */
export async function proposeSeeds(
  domain: string,
  services: string[],
  opts: ProposeSeedsOptions = {},
): Promise<SeedProposalGroup[]> {
  const { system, prompt } = buildPrompt(domain, services, opts)
  let text: string
  try {
    text = await callClaude(prompt, { model: SEED_MODEL, maxTokens: 2048, system })
  } catch (err) {
    if (err instanceof ClaudeApiError) {
      throw new Error(`Seed proposal failed: ${err.message}`)
    }
    throw err
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(extractJsonObject(text))
  } catch (err) {
    throw new Error(
      `Seed proposal returned invalid JSON: ${err instanceof Error ? err.message : "unknown"}`,
    )
  }
  const result = claudeSeedSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(`Seed proposal shape invalid: ${result.error.message}`)
  }

  // Dedupe seeds within each group, lowercase-compare.
  const groups = result.data.groups.map((g) => {
    const seen = new Set<string>()
    const seeds: string[] = []
    for (const raw of g.seeds) {
      const s = raw.trim()
      const k = s.toLowerCase()
      if (!s || seen.has(k)) continue
      seen.add(k)
      seeds.push(s)
    }
    return { service: g.service, seeds }
  })

  // National-volume probe: one search_volume call over every unique seed.
  const uniqueSeeds = Array.from(
    new Set(groups.flatMap((g) => g.seeds.map((s) => s.toLowerCase()))),
  )
  const volByKw = new Map<string, number | null>()
  if (uniqueSeeds.length > 0) {
    try {
      const rows = await searchVolume(uniqueSeeds, COUNTRY_LOC)
      for (const r of rows) {
        volByKw.set(r.keyword.toLowerCase(), r.search_volume ?? null)
      }
    } catch (err) {
      console.warn(
        `[keyword-research] seed volume probe failed: ${err instanceof Error ? err.message : "unknown"}`,
      )
    }
  }

  return groups.map((g) => ({
    service: g.service,
    seeds: g.seeds.map((seed) => ({
      seed,
      nationalVolume: volByKw.get(seed.toLowerCase()) ?? null,
    })),
  }))
}
