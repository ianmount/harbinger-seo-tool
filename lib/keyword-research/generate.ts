import "server-only"
import {
  DFS_LABS_COUNTRY_CODE_US,
  keywordSuggestions,
  relatedKeywords,
} from "@/lib/dataforseo"
import type { DfsLocation } from "@/lib/types"
import type { RawCandidate } from "./curate"

/**
 * Step 3 of the keyword-research flow: generate national candidates per seed
 * from two Labs sources.
 *
 *   A. keyword_suggestions — the spine (full-text: only terms containing the
 *      seed phrase, so results stay anchored to the service).
 *   B. related_keywords    — the breadth source (Google's "searches related
 *      to", depth 2 ≈ adjacent customer-intent queries).
 *
 * Both run country-only (Labs endpoints reject cities). Keywords with no
 * national volume are dropped here — they won't carry local demand either,
 * and they'd only bloat the curation/review. The full per-keyword payload
 * (core_keyword, KD, intent, CPC) is captured for the curator.
 */

const COUNTRY_LOC: DfsLocation = { code: DFS_LABS_COUNTRY_CODE_US }
const SUGGESTIONS_LIMIT = 300
const RELATED_LIMIT = 200
const RELATED_DEPTH = 2

export interface GenerateOutput {
  raw: RawCandidate[]
  warnings: string[]
}

function hasVolume(v: number | undefined): boolean {
  return typeof v === "number" && v > 0
}

export async function generateCandidates(
  seeds: string[],
): Promise<GenerateOutput> {
  const raw: RawCandidate[] = []
  const warnings: string[] = []

  // Fan out per seed; settle-all so one failed seed doesn't sink the run.
  const tasks = seeds.flatMap((seed) => [
    {
      seed,
      source: "suggestions" as const,
      run: () => keywordSuggestions(seed, COUNTRY_LOC, { limit: SUGGESTIONS_LIMIT }),
    },
    {
      seed,
      source: "related" as const,
      run: () =>
        relatedKeywords(seed, COUNTRY_LOC, {
          limit: RELATED_LIMIT,
          depth: RELATED_DEPTH,
        }),
    },
  ])

  const settled = await Promise.allSettled(tasks.map((t) => t.run()))
  settled.forEach((res, i) => {
    const { seed, source } = tasks[i]
    if (res.status === "fulfilled") {
      for (const result of res.value) {
        if (!hasVolume(result.search_volume)) continue
        raw.push({ seed, source, result })
      }
    } else {
      warnings.push(
        `${source} for "${seed}" failed: ${
          res.reason instanceof Error ? res.reason.message : String(res.reason)
        }`,
      )
    }
  })

  return { raw, warnings }
}
