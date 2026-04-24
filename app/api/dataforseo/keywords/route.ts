import { NextResponse } from "next/server"
import { z } from "zod"
import {
  bulkKeywordDifficulty,
  DataForSEOError,
  keywordIdeas,
  keywordSuggestions,
  searchVolume,
} from "@/lib/dataforseo"
import type { DfsLocation } from "@/lib/types"

export const dynamic = "force-dynamic"

// Prefer `locationCode` (numeric DFS location ID) — names are fragile across
// DFS's Labs vs Google Ads taxonomies. `location` (string name) is still
// accepted for quick one-off testing and backwards compatibility.
const locationRefine = (
  v: { location?: string; locationCode?: number },
): boolean => Boolean(v.location) || Boolean(v.locationCode)
const locationError = { message: "Provide locationCode (preferred) or location" }

const bodySchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("ideas"),
      seed: z.string().trim().min(1),
      limit: z.number().int().positive().max(1000).optional(),
      location: z.string().trim().min(1).optional(),
      locationCode: z.number().int().positive().optional(),
    })
    .refine(locationRefine, locationError),
  z
    .object({
      mode: z.literal("suggestions"),
      seed: z.string().trim().min(1),
      limit: z.number().int().positive().max(1000).optional(),
      location: z.string().trim().min(1).optional(),
      locationCode: z.number().int().positive().optional(),
    })
    .refine(locationRefine, locationError),
  z
    .object({
      mode: z.literal("volume"),
      keywords: z.array(z.string().trim().min(1)).min(1).max(1000),
      location: z.string().trim().min(1).optional(),
      locationCode: z.number().int().positive().optional(),
    })
    .refine(locationRefine, locationError),
  z
    .object({
      mode: z.literal("difficulty"),
      keywords: z.array(z.string().trim().min(1)).min(1).max(1000),
      location: z.string().trim().min(1).optional(),
      locationCode: z.number().int().positive().optional(),
    })
    .refine(locationRefine, locationError),
])

function buildLocation(
  code: number | undefined,
  name: string | undefined,
): DfsLocation {
  if (code != null) return { code }
  if (name) return { name }
  throw new Error("locationCode or location is required")
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

  const data = parsed.data
  const location = buildLocation(data.locationCode, data.location)

  try {
    switch (data.mode) {
      case "ideas": {
        const results = await keywordIdeas(data.seed, location, {
          limit: data.limit,
        })
        return NextResponse.json({ results })
      }
      case "suggestions": {
        const results = await keywordSuggestions(data.seed, location, {
          limit: data.limit,
        })
        return NextResponse.json({ results })
      }
      case "volume": {
        const results = await searchVolume(data.keywords, location)
        return NextResponse.json({ results })
      }
      case "difficulty": {
        const results = await bulkKeywordDifficulty(data.keywords, location)
        return NextResponse.json({ results })
      }
    }
  } catch (error: unknown) {
    console.error("[api/dataforseo/keywords] failed:", error)
    return errorResponse(error)
  }
}
