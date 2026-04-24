import { NextResponse } from "next/server"
import { z } from "zod"
import {
  bulkKeywordDifficulty,
  DataForSEOError,
  keywordIdeas,
  keywordSuggestions,
  searchVolume,
} from "@/lib/dataforseo"
import type { KeywordResult } from "@/lib/types"

export const dynamic = "force-dynamic"

// Accepts either a single location name (legacy) or an ordered list of
// candidates. Candidates are tried in order and we fall through on DFS
// status 40501 ("Invalid Field: location_name") — this is how we handle
// smaller US cities that aren't in DFS's location taxonomy, falling back
// from city → state → country.
const locationField = z.union([
  z.string().trim().min(1),
  z.array(z.string().trim().min(1)).min(1),
])

const seedBase = z.object({
  seed: z.string().trim().min(1),
  location: locationField,
  limit: z.number().int().positive().max(1000).optional(),
})

const keywordsBase = z.object({
  keywords: z.array(z.string().trim().min(1)).min(1).max(1000),
  location: locationField,
})

const bodySchema = z.discriminatedUnion("mode", [
  seedBase.extend({ mode: z.literal("ideas") }),
  seedBase.extend({ mode: z.literal("suggestions") }),
  keywordsBase.extend({ mode: z.literal("volume") }),
  keywordsBase.extend({ mode: z.literal("difficulty") }),
])

function toCandidates(location: string | string[]): string[] {
  return Array.isArray(location) ? location : [location]
}

async function tryLocationCandidates(
  candidates: string[],
  fn: (location: string) => Promise<KeywordResult[]>,
): Promise<{ results: KeywordResult[]; locationUsed: string }> {
  let lastErr: unknown
  const tried: string[] = []
  for (const loc of candidates) {
    try {
      const results = await fn(loc)
      return { results, locationUsed: loc }
    } catch (err) {
      lastErr = err
      tried.push(loc)
      if (
        err instanceof DataForSEOError &&
        err.dfsStatus === 40501
      ) {
        console.warn(
          `[dataforseo] location "${loc}" rejected by DFS (40501), trying next fallback`,
        )
        continue
      }
      throw err
    }
  }
  if (lastErr instanceof DataForSEOError) {
    throw new DataForSEOError(
      `DataForSEO rejected all ${tried.length} location candidates (${tried.join(" → ")}). Last error: ${lastErr.message}`,
      { dfsStatus: lastErr.dfsStatus, status: lastErr.status },
    )
  }
  throw (
    lastErr ?? new Error("No DataForSEO location candidates were provided")
  )
}

function errorResponse(error: unknown) {
  if (error instanceof DataForSEOError) {
    const status = error.status ?? 502
    return NextResponse.json({ error: error.message }, { status })
  }
  const message = error instanceof Error ? error.message : "Unknown error"
  return NextResponse.json({ error: message }, { status: 500 })
}

export async function POST(request: Request) {
  let rawBody: unknown
  try {
    rawBody = await request.json()
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON" },
      { status: 400 },
    )
  }

  const parsed = bodySchema.safeParse(rawBody)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request body", issues: parsed.error.flatten() },
      { status: 400 },
    )
  }

  const candidates = toCandidates(parsed.data.location)

  try {
    const data = parsed.data
    switch (data.mode) {
      case "ideas": {
        const { results, locationUsed } = await tryLocationCandidates(
          candidates,
          (loc) => keywordIdeas(data.seed, { name: loc }, { limit: data.limit }),
        )
        return NextResponse.json({ results, locationUsed })
      }
      case "suggestions": {
        const { results, locationUsed } = await tryLocationCandidates(
          candidates,
          (loc) =>
            keywordSuggestions(data.seed, { name: loc }, { limit: data.limit }),
        )
        return NextResponse.json({ results, locationUsed })
      }
      case "volume": {
        const { results, locationUsed } = await tryLocationCandidates(
          candidates,
          (loc) => searchVolume(data.keywords, { name: loc }),
        )
        return NextResponse.json({ results, locationUsed })
      }
      case "difficulty": {
        const { results, locationUsed } = await tryLocationCandidates(
          candidates,
          (loc) => bulkKeywordDifficulty(data.keywords, { name: loc }),
        )
        return NextResponse.json({ results, locationUsed })
      }
    }
  } catch (error: unknown) {
    console.error("[api/dataforseo/keywords] failed:", error)
    return errorResponse(error)
  }
}
