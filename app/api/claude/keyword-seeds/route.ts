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
  seeds: z.array(z.string().trim().min(1)).min(1).max(200),
})

const MAX_SEEDS = 120

const SYSTEM_PROMPT =
  "You are an SEO strategist for local service businesses. You read a richly written business-context blob (services, ideal customers, audience nuances, scope exclusions) and a list of selected target locations, and you produce a focused list of keyword candidates. Your list is the FINAL keyword set evaluated for the user — there is no expansion step downstream — so coverage and phrasing matter. Reply with a single JSON object — no markdown fences, no commentary."

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
    `Produce up to ${MAX_SEEDS} keyword candidates for this business. There is NO downstream expansion step — DataForSEO will look up city-level search volume for each, then probe live SERPs to see where the domain currently ranks. What you write is what the user evaluates. Cover the search space yourself by combining each city × each major service × multiple qualifier variants × both word orders.`,
  )
  lines.push("")
  lines.push(`## Hard rules`)
  lines.push(
    `1. **Use the context blob to bias selection.** If the blob names ideal customers (e.g. "luxury homeowners", "first-time homebuyers", "small businesses"), prefer phrasings that customer would actually type. If it lists scope exclusions (e.g. "no commercial work", "residential only"), drop candidates that imply the excluded scope. If it calls out specialties ("we specialize in tankless water heaters"), include dedicated candidates for those specialties.`,
  )
  lines.push(
    `2. **Geo-bound dominates.** For each target city, generate candidates combining the city name with each major service category. Produce ALL of:`,
  )
  lines.push(
    `   - Both word orders ("plumber atlanta" AND "atlanta plumber") — real searches go both ways`,
  )
  lines.push(
    `   - Qualifier variants for each service ("best plumber atlanta", "emergency plumber atlanta", "24 hour plumber atlanta", "affordable plumber atlanta", "licensed plumber atlanta") — pick 3-5 qualifiers per service that match the business's positioning from the context`,
  )
  lines.push(
    `   - Service-specific variants ("drain cleaning atlanta", "water heater repair atlanta", "tankless water heater installation atlanta") covering each named service`,
  )
  lines.push(
    `   - Prep variants where natural ("plumber in atlanta", "plumbers in atlanta", "atlanta area plumber")`,
  )
  lines.push(
    `3. **Small near-me bucket: 3-6 candidates total.** Generic "<service> near me" or "emergency <service> near me". These pick up off-location intent. Bigger bucket isn't useful — they get deduped against geo-bound twins downstream.`,
  )
  lines.push(
    `4. **Do NOT include cities or states the business doesn't serve.** If the location list has only Atlanta and Charlotte, never write a candidate mentioning Dallas, Austin, Las Vegas, or any other city.`,
  )
  lines.push(
    `5. **Do NOT include the brand or domain name.** We want category demand, not branded search.`,
  )
  lines.push(
    `6. **Lowercase. No punctuation other than internal spaces. No quotes.**`,
  )
  lines.push(
    `7. **Length: 2–7 words.** Tail terms like "tankless water heater installation atlanta" are valuable. Single-word queries are too generic.`,
  )
  lines.push("")
  lines.push(`## Composition guidance`)
  lines.push(
    `For a typical run with 1–3 locations and 3–6 service categories, aim for roughly:`,
  )
  lines.push(
    `- 85–95% geo-bound (city × service × qualifier × word order combinations)`,
  )
  lines.push(`- 5–15% near-me / pure-category generic bucket`)
  lines.push(
    `Cap the total at ${MAX_SEEDS}. If your full city × service × qualifier × word-order grid exceeds the cap, prioritize: (a) primary services first, (b) qualifiers that best match the business's positioning, (c) both word orders for top services, (d) drop secondary qualifiers and lower-priority services.`,
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
    `- Brief geographic strategy ("covered Atlanta and Charlotte in both word orders for each primary service, with qualifier variants like best/emergency/24-hour; small near-me bucket for off-location intent").`,
  )
  lines.push(
    `If the context blob was thin or generic, say so honestly ("context was light on audience signal — defaulted to broad service-category candidates; richer audience info would tighten the pool"). Be concrete; quote phrases from the context where it helps. Avoid generic SEO platitudes.`,
  )
  lines.push("")
  lines.push(`# Output format`)
  lines.push(
    `Output exactly one JSON object with a "reasoning" string and a "seeds" array of strings. No prose outside the JSON, no markdown fences.`,
  )
  lines.push("```")
  lines.push(`{`)
  lines.push(
    `  "reasoning": "Read the context as residential plumbing for older single-family homes — leaned into repair / emergency / specific-failure phrasings over informational. Dropped commercial and new-construction candidates. Added dedicated tankless retrofit candidates since that was called out as a specialty. Geo focus: Atlanta and Charlotte in both word orders for each service, with best/emergency/24-hour qualifier variants; small near-me bucket for off-location intent.",`,
  )
  lines.push(`  "seeds": [`)
  lines.push(
    `    "plumber atlanta", "atlanta plumber", "best plumber atlanta", "emergency plumber atlanta", "24 hour plumber atlanta", "licensed plumber atlanta", "plumber in atlanta", "plumbers in atlanta",`,
  )
  lines.push(
    `    "drain cleaning atlanta", "atlanta drain cleaning", "emergency drain cleaning atlanta",`,
  )
  lines.push(
    `    "water heater repair atlanta", "atlanta water heater repair", "tankless water heater installation atlanta", "tankless water heater repair atlanta",`,
  )
  lines.push(
    `    "plumber charlotte", "charlotte plumber", "best plumber charlotte", "emergency plumber charlotte", "drain cleaning charlotte",`,
  )
  lines.push(
    `    "plumber near me", "emergency plumber near me", "24 hour plumber"`,
  )
  lines.push(`  ]`)
  lines.push(`}`)
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
    parsed.data.context,
    parsed.data.domain,
    parsed.data.locations,
  )

  try {
    const text = await callClaude(prompt, {
      system: SYSTEM_PROMPT,
      maxTokens: 6144,
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
