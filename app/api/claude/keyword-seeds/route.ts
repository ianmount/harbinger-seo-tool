import { NextResponse } from "next/server"
import { z } from "zod"
import { callClaude, ClaudeApiError } from "@/lib/claude"

export const dynamic = "force-dynamic"

const bodySchema = z.object({
  services: z.string().trim().min(1),
  domain: z.string().trim().optional(),
  locations: z.array(z.string().trim().min(1)).optional(),
})

const responseSchema = z.object({
  seeds: z.array(z.string().trim().min(1)).min(1).max(20),
})

const MAX_SEEDS = 12

const SYSTEM_PROMPT =
  "You are an SEO strategist. Given a description of a local service business, return short seed keywords that capture the core services a customer would search for. Reply with a single JSON object — no markdown fences, no commentary."

function buildPrompt(
  services: string,
  domain: string | undefined,
  locations: ReadonlyArray<string>,
): string {
  const lines: string[] = []
  lines.push(`# Business context`)
  if (domain) lines.push(`Domain: ${domain}`)
  lines.push(`Services / context:\n${services}`)
  if (locations.length > 0) {
    lines.push(`Markets: ${locations.join("; ")}`)
  }
  lines.push("")
  lines.push(`# Task`)
  lines.push(
    `Produce 8–${MAX_SEEDS} seed keywords that will be fed into DataForSEO's keyword_ideas and keyword_suggestions endpoints to expand into a full candidate pool.`,
  )
  lines.push("")
  lines.push(`## Rules`)
  lines.push(
    `- Each seed should be 1–4 words: a head term or short phrase a customer would search (e.g. "water heater repair", "emergency plumber", "drain cleaning").`,
  )
  lines.push(
    `- Cover the distinct service categories implied by the description. Don't list ten variants of the same service — pick the strongest representative for each.`,
  )
  lines.push(
    `- Do NOT include city / state / "near me" qualifiers. DataForSEO will expand geographic variations downstream.`,
  )
  lines.push(
    `- Do NOT include the brand or domain name. We want category demand, not branded search.`,
  )
  lines.push(`- Lowercase. No punctuation other than internal spaces.`)
  lines.push("")
  lines.push(`# Output format`)
  lines.push(
    `Output exactly one JSON object with a "seeds" array of strings. No prose, no markdown fences.`,
  )
  lines.push("```")
  lines.push(`{ "seeds": ["water heater repair", "emergency plumber", "drain cleaning"] }`)
  lines.push("```")
  return lines.join("\n")
}

function stripCodeFences(text: string): string {
  const trimmed = text.trim()
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i)
  return fenceMatch ? fenceMatch[1].trim() : trimmed
}

function extractJsonObject(text: string): string {
  const stripped = stripCodeFences(text)
  const first = stripped.indexOf("{")
  const last = stripped.lastIndexOf("}")
  if (first === -1 || last === -1 || last <= first) return stripped
  return stripped.slice(first, last + 1)
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

  const prompt = buildPrompt(
    parsed.data.services,
    parsed.data.domain,
    parsed.data.locations ?? [],
  )

  try {
    const text = await callClaude(prompt, {
      system: SYSTEM_PROMPT,
      maxTokens: 1024,
    })
    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(extractJsonObject(text))
    } catch (err) {
      throw new Error(
        `Claude did not return valid JSON: ${err instanceof Error ? err.message : "unknown"}`,
      )
    }
    const result = responseSchema.safeParse(parsedJson)
    if (!result.success) {
      throw new Error(
        `Claude response did not match schema: ${result.error.message}`,
      )
    }

    const seen = new Set<string>()
    const seeds: string[] = []
    for (const seed of result.data.seeds) {
      const normalized = seed.toLowerCase().trim()
      if (!normalized || seen.has(normalized)) continue
      seen.add(normalized)
      seeds.push(normalized)
      if (seeds.length >= MAX_SEEDS) break
    }
    if (seeds.length === 0) {
      throw new Error("Claude returned no usable seed keywords")
    }
    return NextResponse.json({ seeds })
  } catch (error: unknown) {
    console.error("[api/claude/keyword-seeds] failed:", error)
    if (error instanceof ClaudeApiError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status ?? 502 },
      )
    }
    const message = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
