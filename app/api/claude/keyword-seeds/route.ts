import { NextResponse } from "next/server"
import { z } from "zod"
import { callClaude, ClaudeApiError } from "@/lib/claude"

export const dynamic = "force-dynamic"

const bodySchema = z.object({
  context: z.string().trim().min(1),
  domain: z.string().trim().optional(),
  locations: z.array(z.string().trim().min(1)).min(1),
})

const responseSchema = z.object({
  reasoning: z.string().trim().min(1),
  seeds: z.array(z.string().trim().min(1)).min(1).max(120),
})

const MAX_SEEDS = 60

const SYSTEM_PROMPT =
  "You are an SEO strategist for local service businesses. You read a richly written business-context blob (services, ideal customers, audience nuances, scope exclusions) and a list of selected target locations, and you produce a list of seed phrases that DataForSEO's keyword_suggestions endpoint will expand into a candidate keyword pool. Each seed becomes a substring filter — DFS returns every keyword in its database that contains the seed. Reply with a single JSON object — no markdown fences, no commentary."

function buildPrompt(
  context: string,
  domain: string | undefined,
  locations: ReadonlyArray<string>,
): string {
  const lines: string[] = []
  lines.push(`# Business context`)
  if (domain) lines.push(`Domain: ${domain}`)
  lines.push(`Context blob (services, audience, nuances, exclusions):`)
  lines.push(context)
  lines.push("")
  lines.push(`# Target locations`)
  lines.push(
    `These are the ONLY markets the business cares about. Use these exact city names in your geo-bound seeds — do not substitute related cities or invent new ones.`,
  )
  for (const loc of locations) lines.push(`- ${loc}`)
  lines.push("")
  lines.push(`# Task`)
  lines.push(
    `Produce up to ${MAX_SEEDS} seed phrases. These will be fed into DataForSEO's keyword_suggestions endpoint, which returns every keyword in DFS's database that contains the seed as a substring. So every seed becomes a substring filter — phrasing matters. DFS handles all the volume + variant discovery; your job is to pick seed phrases that span the geography × service grid efficiently.`,
  )
  lines.push("")
  lines.push(`## Hard rules`)
  lines.push(
    `1. **Use the context blob to bias selection.** If the blob names ideal customers (e.g. "luxury homeowners", "first-time homebuyers", "small businesses"), prefer phrasings that customer would actually type. If it lists scope exclusions (e.g. "no commercial work", "residential only"), drop seeds that imply the excluded scope. If it calls out specialties ("we specialize in tankless water heaters"), include dedicated seeds for those specialties.`,
  )
  lines.push(
    `2. **EVERY seed must be geo-bound.** Each seed must contain at least one of the target city names from the location list. For each target city, generate seeds combining the city name with each major service category. Use both word orders ("plumber atlanta" AND "atlanta plumber") since real searches go either way. Use the city name only — don't add the state in seeds; DFS suggestions for "plumber atlanta" already covers "plumber atlanta ga".`,
  )
  lines.push(
    `3. **DO NOT generate bare-service seeds.** Pure category heads like "plumber" or "drain cleaning" without geography expand via DFS substring match into every other US city's variants ("plumber dallas", "plumber chicago", "plumber phoenix") — and those leak into the user's selected city tab because they don't mention a state. Always pin the seed to one of the target cities.`,
  )
  lines.push(
    `4. **DO NOT include "near me" in any seed.** Seeds like "plumber near me" expand to a flood of high-volume national near-me variants that swamp the city-bound results downstream. Skip near-me entirely.`,
  )
  lines.push(
    `5. **Do NOT include cities or states the business doesn't serve.** If the location list has only Atlanta and Charlotte, never write a seed mentioning Dallas, Austin, Las Vegas, or any other city.`,
  )
  lines.push(
    `6. **Do NOT include the brand or domain name.** We want category demand, not branded search.`,
  )
  lines.push(
    `7. **Do NOT include state names or two-letter state abbreviations** in the seeds. ("plumber atlanta" is good, "plumber atlanta ga" is bad — DFS will surface the GA variants from the unsuffixed seed.)`,
  )
  lines.push(
    `8. **Keep each seed to 2–4 words.** Suggestions endpoint matches substrings; longer seeds dramatically narrow the result set. "tankless water heater" expands well; "tankless water heater installation cost" barely expands at all.`,
  )
  lines.push(
    `9. **Lowercase. No punctuation other than internal spaces. No quotes.**`,
  )
  lines.push("")
  lines.push(`## Composition guidance`)
  lines.push(
    `For a typical run with 1–3 locations and 3–6 service categories, the seed list is roughly cities × services × 2 word orders. Cap the total at ${MAX_SEEDS}. If that grid would exceed the cap, keep the strongest service categories and drop the rest rather than duplicating qualifiers.`,
  )
  lines.push("")
  lines.push(`# Reasoning blurb`)
  lines.push(
    `Alongside the seeds, write a 2–4 sentence reasoning blurb explaining how you read this specific business context and how that shaped the seed list. Touch only on points that actually apply to this run — skip ones that don't:`,
  )
  lines.push(
    `- What audience signal you picked up (e.g. "context skews to problem-aware homeowners in older homes — leaned into repair / emergency phrasings over informational").`,
  )
  lines.push(
    `- Any scope exclusions you applied (e.g. "dropped commercial-coded seeds because the scope is residential only").`,
  )
  lines.push(
    `- Any specialties you weighted up (e.g. "added dedicated tankless seeds since that was called out as a specialty; downplayed tank-style installs").`,
  )
  lines.push(
    `- Brief geographic strategy ("baked Atlanta and Charlotte into most seeds in both word orders; small bare-service bucket for head-term coverage").`,
  )
  lines.push(
    `If the context blob was thin or generic, say so honestly ("context was light on audience signal — defaulted to broad service-category seeds; richer audience info would tighten the pool"). Be concrete; quote phrases from the context where it helps. Avoid generic SEO platitudes.`,
  )
  lines.push("")
  lines.push(`# Output format`)
  lines.push(
    `Output exactly one JSON object with a "reasoning" string and a "seeds" array of strings. No prose outside the JSON, no markdown fences.`,
  )
  lines.push("```")
  lines.push(`{`)
  lines.push(
    `  "reasoning": "Read the context as residential plumbing for older single-family homes — leaned into repair / emergency / specific-failure phrasings over informational. Dropped commercial and new-construction seeds. Added dedicated tankless retrofit seeds since that was called out as a specialty. Geo focus: Atlanta and Charlotte in both word orders. Every seed is pinned to a target city — no bare-service seeds, no near-me.",`,
  )
  lines.push(`  "seeds": [`)
  lines.push(
    `    "plumber atlanta", "atlanta plumber", "drain cleaning atlanta", "atlanta drain cleaning", "water heater repair atlanta", "atlanta water heater repair", "tankless water heater atlanta", "atlanta tankless water heater",`,
  )
  lines.push(
    `    "plumber charlotte", "charlotte plumber", "drain cleaning charlotte", "charlotte drain cleaning", "water heater repair charlotte", "charlotte water heater repair", "tankless water heater charlotte"`,
  )
  lines.push(`  ]`)
  lines.push(`}`)
  lines.push("```")
  return lines.join("\n")
}

/**
 * Pull lowercase city/state phrases out of the user-provided location strings
 * (typically DFS `location_name` like "Atlanta,Georgia,United States"). Used
 * to validate that every Claude-generated seed mentions at least one target
 * location.
 */
function extractLocationWords(locations: ReadonlyArray<string>): string[] {
  const out = new Set<string>()
  for (const loc of locations) {
    for (const part of loc.split(",")) {
      const cleaned = part.trim().toLowerCase()
      if (!cleaned || cleaned === "united states") continue
      out.add(cleaned)
    }
  }
  return Array.from(out)
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
    parsed.data.context,
    parsed.data.domain,
    parsed.data.locations,
  )

  try {
    const text = await callClaude(prompt, {
      system: SYSTEM_PROMPT,
      maxTokens: 3072,
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

    // Defense-in-depth: drop seeds the prompt forbids in case Claude slips.
    // - Bare-service seeds ("plumber") let DFS substring-expand to other US
    //   cities ("plumber dallas"), which leak past our state filter.
    // - Near-me seeds ("plumber near me") flood the pool with national
    //   variants that swamp the city volume sort downstream.
    const locationWords = extractLocationWords(parsed.data.locations)
    const NEAR_ME = /\bnear me\b/
    const seen = new Set<string>()
    const seeds: string[] = []
    let droppedNotGeoBound = 0
    let droppedNearMe = 0
    for (const seed of result.data.seeds) {
      const normalized = seed.toLowerCase().trim()
      if (!normalized || seen.has(normalized)) continue
      if (NEAR_ME.test(normalized)) {
        droppedNearMe++
        continue
      }
      if (
        locationWords.length > 0 &&
        !locationWords.some((w) => normalized.includes(w))
      ) {
        droppedNotGeoBound++
        continue
      }
      seen.add(normalized)
      seeds.push(normalized)
      if (seeds.length >= MAX_SEEDS) break
    }
    if (droppedNotGeoBound > 0 || droppedNearMe > 0) {
      console.log(
        `[api/claude/keyword-seeds] dropped ${droppedNotGeoBound} non-geo-bound + ${droppedNearMe} near-me seed(s) from Claude output`,
      )
    }
    if (seeds.length === 0) {
      throw new Error("Claude returned no usable seed keywords")
    }
    return NextResponse.json({ seeds, reasoning: result.data.reasoning.trim() })
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
