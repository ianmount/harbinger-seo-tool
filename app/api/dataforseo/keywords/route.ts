import { NextResponse } from "next/server"
import { z } from "zod"
import {
  bulkKeywordDifficulty,
  DataForSEOError,
  keywordIdeas,
  keywordSuggestions,
  searchVolume,
} from "@/lib/dataforseo"

export const dynamic = "force-dynamic"

const seedBase = z.object({
  seed: z.string().trim().min(1),
  location: z.string().trim().min(1),
  limit: z.number().int().positive().max(1000).optional(),
})

const keywordsBase = z.object({
  keywords: z.array(z.string().trim().min(1)).min(1).max(1000),
  location: z.string().trim().min(1),
})

const bodySchema = z.discriminatedUnion("mode", [
  seedBase.extend({ mode: z.literal("ideas") }),
  seedBase.extend({ mode: z.literal("suggestions") }),
  keywordsBase.extend({ mode: z.literal("volume") }),
  keywordsBase.extend({ mode: z.literal("difficulty") }),
])

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

  const { location } = parsed.data
  const locationParam = { name: location }

  try {
    switch (parsed.data.mode) {
      case "ideas": {
        const results = await keywordIdeas(parsed.data.seed, locationParam, {
          limit: parsed.data.limit,
        })
        return NextResponse.json({ results })
      }
      case "suggestions": {
        const results = await keywordSuggestions(
          parsed.data.seed,
          locationParam,
          { limit: parsed.data.limit },
        )
        return NextResponse.json({ results })
      }
      case "volume": {
        const results = await searchVolume(parsed.data.keywords, locationParam)
        return NextResponse.json({ results })
      }
      case "difficulty": {
        const results = await bulkKeywordDifficulty(
          parsed.data.keywords,
          locationParam,
        )
        return NextResponse.json({ results })
      }
    }
  } catch (error: unknown) {
    console.error("[api/dataforseo/keywords] failed:", error)
    return errorResponse(error)
  }
}
