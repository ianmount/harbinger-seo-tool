import { NextResponse } from "next/server"
import { z } from "zod"
import { callClaude, ClaudeApiError } from "@/lib/claude"
import type {
  CategorizedProspect,
  OutreachPriority,
  ProspectCategory,
  ReferringDomain,
} from "@/lib/types"

export const dynamic = "force-dynamic"

const partnerSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    services: z.string(),
    serviceAreas: z.string(),
    website: z.string(),
    partnerGoals: z.string().optional(),
    targetAudience: z.string().optional(),
    industryKnowledge: z.string().optional(),
  })
  .passthrough()

const prospectInputSchema = z.object({
  domain: z.string().trim().min(1),
  rank: z.number(),
  backlinks: z.number().optional(),
  spamScore: z.number().optional(),
  firstSeen: z.string().optional(),
  referringTo: z.string(),
})

const bodySchema = z.object({
  partner: partnerSchema,
  prospects: z.array(prospectInputSchema).min(1).max(300),
})

type ParsedBody = z.infer<typeof bodySchema>

// Compact tuple output: [domain, category, angle, reasoning, priority].
// Same reasoning as /api/claude/keywords — keeping per-prospect token cost
// low lets us score 100+ domains in a single Claude call.
const categoryEnum = z.enum([
  "citation",
  "resource_page",
  "editorial",
  "supplier",
  "other",
])
const priorityEnum = z.enum(["high", "medium", "low"])

const claudeTupleSchema = z.tuple([
  z.string(), // domain (verbatim)
  categoryEnum,
  z.string(), // angle (1 sentence)
  z.string(), // reasoning (1 sentence)
  priorityEnum,
])

const claudeResponseSchema = z.object({
  prospects: z.array(claudeTupleSchema),
})

const CLAUDE_MAX_TOKENS = 16000
const MAX_PROSPECTS_PER_CALL = 200

const SYSTEM_PROMPT =
  "You are a link-building strategist categorizing referring domains for a local service business outreach campaign. Your job is to (a) classify each domain into one of five buckets based on what kind of site it is, (b) suggest a one-sentence outreach angle tailored to the partner, and (c) set an outreach priority. Be honest about uncertainty: if the domain name alone doesn't tell you what kind of site it is, use the 'other' category rather than guessing. Do not hallucinate facts about sites you don't recognize. Reply with a single JSON object — no markdown fences, no commentary."

function buildPrompt(body: ParsedBody, prospects: ReferringDomain[]): string {
  const { partner } = body
  const lines: string[] = []

  lines.push(`# Partner profile`)
  lines.push(`Name: ${partner.name}`)
  lines.push(`Website: ${partner.website}`)
  lines.push(`Services:\n${partner.services}`)
  lines.push(`Service areas:\n${partner.serviceAreas}`)
  if (partner.partnerGoals)
    lines.push(`Goals:\n${partner.partnerGoals}`)
  if (partner.targetAudience)
    lines.push(`Target audience:\n${partner.targetAudience}`)
  if (partner.industryKnowledge)
    lines.push(`Industry knowledge:\n${partner.industryKnowledge}`)

  lines.push("")
  lines.push(`# Categories (pick exactly one per domain)`)
  lines.push(
    `- **citation** — directory / listing sites where a business gets a profile page (YellowPages, BBB, Yelp, Angi, HomeAdvisor, Manta, Chamber of Commerce directories, niche trade directories). Outreach = claim or request a listing.`,
  )
  lines.push(
    `- **resource_page** — a curated link list on someone else's site, often titled "Top 10…", "Best…in [city]", "Recommended contractors", "Useful links for homeowners". Outreach = ask to be added to the list.`,
  )
  lines.push(
    `- **editorial** — a publication that runs articles (local newspaper, industry blog, trade magazine, general-interest blog). Outreach = pitch a contributed article, expert quote, or story idea.`,
  )
  lines.push(
    `- **supplier** — a business whose site could mention the partner in a "Partners", "Dealers", "Installers", "Where to buy", or "Vendors" section. Typically a manufacturer, wholesaler, franchise HQ, or B2B vendor relevant to the partner's industry. Outreach = ask for inclusion in their partner/vendor list.`,
  )
  lines.push(
    `- **other** — anything you cannot confidently place in the four categories above. Do NOT guess. Domains like forum aggregators, wikis, archive.org, social media profile dumps, and non-English sites usually belong here. Mark priority 'low' for these unless you have a clear signal otherwise.`,
  )

  lines.push("")
  lines.push(`# Outreach priority`)
  lines.push(
    `- **high** — strong topical fit (same industry or adjacent local-services niche) AND the category is actionable (citation, resource_page, supplier). Think "this is worth a personalized email today".`,
  )
  lines.push(
    `- **medium** — actionable but less obvious fit, or a strong fit on a category (editorial) that takes more work to land. Worth pursuing in the second wave.`,
  )
  lines.push(
    `- **low** — weak fit, unclear category, or a referrer that probably scraped a listing somewhere. Skip or defer.`,
  )

  lines.push("")
  lines.push(`# Prospects to categorize`)
  lines.push(
    `Each row shows a referring domain with its DataForSEO rank (0–1000, higher = stronger authority), number of backlinks it has pointing at the competitor, and which competitor's backlink profile it appeared in.`,
  )
  lines.push(`| # | Domain | Rank | Backlinks | Linking to competitor |`)
  lines.push(`|---:|---|---:|---:|---|`)
  prospects.forEach((p, i) => {
    lines.push(
      `| ${i + 1} | ${p.domain} | ${p.rank} | ${p.backlinks} | ${p.referringTo} |`,
    )
  })

  lines.push("")
  lines.push(`# Output format`)
  lines.push(
    `Output exactly one JSON object. No prose, no markdown fences. Each prospect is a 5-element tuple in this exact order: [domain (verbatim from input), category, angle, reasoning, priority].`,
  )
  lines.push(
    `- **angle** — one sentence (under 25 words), describing what you would ask this specific domain for. Reference something concrete when the domain name plausibly supports it (e.g. "Ask to be added to the 'Recommended local HVAC contractors' list on bbb.org/…"). Avoid generic phrases like "pitch a guest post".`,
  )
  lines.push(
    `- **reasoning** — one sentence (under 25 words), stating WHY you chose this category. Anchor to the domain name and any signal you can infer; when nothing concrete is inferable, say "Domain name alone is ambiguous" and use 'other'.`,
  )
  lines.push(
    `- The "domain" field of each tuple must match a domain from the prospect list verbatim. Do NOT invent domains.`,
  )
  lines.push("```")
  lines.push(`{`)
  lines.push(`  "prospects": [`)
  lines.push(
    `    ["bbb.org", "citation", "Claim or verify the partner's profile on BBB's local business directory.", "BBB is a well-known accredited-business directory, so a profile there is a citation link.", "high"],`,
  )
  lines.push(
    `    ["homeownersguide.example", "resource_page", "Ask to be added to the 'Local plumbers we recommend' list.", "Domain name suggests a curated homeowner resource hub.", "medium"]`,
  )
  lines.push(`  ]`)
  lines.push(`}`)
  lines.push("```")
  lines.push(
    `Return one tuple per input prospect (${prospects.length} total).`,
  )

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

function healTruncatedJson(text: string): string {
  let depth = 0
  let lastGoodTupleEnd = -1
  let inString = false
  let escape = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (escape) {
      escape = false
      continue
    }
    if (c === "\\") {
      escape = true
      continue
    }
    if (c === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (c === "[") depth++
    else if (c === "]") {
      depth--
      if (depth === 1) lastGoodTupleEnd = i
    }
  }
  if (lastGoodTupleEnd < 0) return text
  return `${text.slice(0, lastGoodTupleEnd + 1)}]}`
}

async function callClaudeForProspects(
  prompt: string,
): Promise<z.infer<typeof claudeResponseSchema>> {
  const raw = await callClaude(prompt, {
    system: SYSTEM_PROMPT,
    maxTokens: CLAUDE_MAX_TOKENS,
  })
  const jsonText = extractJsonObject(raw)
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch (err) {
    const healed = healTruncatedJson(jsonText)
    if (healed === jsonText) {
      throw new Error(
        `Claude did not return valid JSON: ${err instanceof Error ? err.message : "unknown"}`,
      )
    }
    try {
      parsed = JSON.parse(healed)
      console.warn(
        "[api/claude/prospects] healed truncated JSON; some tail prospects dropped",
      )
    } catch (healErr) {
      throw new Error(
        `Claude did not return valid JSON and could not be healed: ${healErr instanceof Error ? healErr.message : "unknown"}`,
      )
    }
  }
  const result = claudeResponseSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(
      `Claude response did not match schema: ${result.error.message}`,
    )
  }
  return result.data
}

function mergeTuplesOntoProspects(
  prospects: ReferringDomain[],
  scored: z.infer<typeof claudeResponseSchema>,
): CategorizedProspect[] {
  const byDomain = new Map<string, ReferringDomain>()
  for (const p of prospects) byDomain.set(p.domain.toLowerCase(), p)

  const out: CategorizedProspect[] = []
  const seen = new Set<string>()
  for (const tuple of scored.prospects) {
    const [domain, category, angle, reasoning, priority] = tuple
    const base = byDomain.get(domain.toLowerCase())
    if (!base) continue
    const key = base.domain.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      ...base,
      category: category as ProspectCategory,
      angle,
      reasoning,
      outreachPriority: priority as OutreachPriority,
    })
  }

  // Any prospect Claude silently dropped falls through as 'other' / low so
  // the UI doesn't lose rows. Better to surface them with a default than to
  // quietly disappear the user's data.
  for (const p of prospects) {
    if (seen.has(p.domain.toLowerCase())) continue
    out.push({
      ...p,
      category: "other",
      angle: "Needs manual review — Claude did not categorize this domain.",
      reasoning: "No response from model for this domain.",
      outreachPriority: "low",
    })
  }

  return out
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

  // Normalize: the incoming schema tolerates missing backlinks/spamScore (so
  // the client can pass the raw filtered output from /api/dataforseo/backlinks
  // without re-declaring fields). Fill defaults before handing to Claude.
  const normalized: ReferringDomain[] = parsed.data.prospects.map((p) => ({
    domain: p.domain,
    rank: p.rank,
    backlinks: p.backlinks ?? 0,
    spamScore: p.spamScore ?? 0,
    firstSeen: p.firstSeen,
    referringTo: p.referringTo,
  }))

  // Clamp input to avoid runaway token spend / truncation. The UI should
  // already filter down to a manageable pool, but defensive cap in case.
  const toScore = normalized.slice(0, MAX_PROSPECTS_PER_CALL)
  const truncated = normalized.length - toScore.length

  const prompt = buildPrompt(parsed.data, toScore)
  try {
    let scored: z.infer<typeof claudeResponseSchema>
    try {
      scored = await callClaudeForProspects(prompt)
    } catch (firstErr) {
      console.warn(
        "[api/claude/prospects] first attempt failed, retrying once:",
        firstErr instanceof Error ? firstErr.message : firstErr,
      )
      const retryPrompt = `${prompt}\n\n# Retry note\nYour previous response was invalid: ${firstErr instanceof Error ? firstErr.message : "parse error"}. Output ONLY the JSON object described above — no markdown, no commentary.`
      scored = await callClaudeForProspects(retryPrompt)
    }

    const merged = mergeTuplesOntoProspects(toScore, scored)
    return NextResponse.json({
      prospects: merged,
      truncated,
      scored: scored.prospects.length,
    })
  } catch (error: unknown) {
    console.error("[api/claude/prospects] failed:", error)
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
