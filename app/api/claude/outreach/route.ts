import { NextResponse } from "next/server"
import { z } from "zod"
import { callClaude, ClaudeApiError } from "@/lib/claude"
import type { OutreachEmail } from "@/lib/types"

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

const categoryEnum = z.enum([
  "citation",
  "resource_page",
  "editorial",
  "supplier",
  "other",
])
const priorityEnum = z.enum(["high", "medium", "low"])

const prospectSchema = z
  .object({
    domain: z.string(),
    rank: z.number(),
    backlinks: z.number(),
    spamScore: z.number(),
    firstSeen: z.string().optional(),
    referringTo: z.string(),
    category: categoryEnum,
    angle: z.string(),
    reasoning: z.string(),
    outreachPriority: priorityEnum,
  })
  .passthrough()

const bodySchema = z.object({
  partner: partnerSchema,
  prospect: prospectSchema,
})

type ParsedBody = z.infer<typeof bodySchema>

const emailSchema = z.object({
  subject: z.string().min(1),
  body: z.string().min(1),
  sendAfterDays: z.number().int().min(0),
})

const claudeResponseSchema = z.object({
  emails: z.array(emailSchema).length(3),
})

const CLAUDE_MAX_TOKENS = 2500

const SYSTEM_PROMPT = [
  "You are an outreach copywriter drafting link-building emails for a local service business. Your job is to produce a 3-email sequence (initial + two follow-ups) that reads like a real human wrote it.",
  "",
  "Hard rules:",
  "- DO NOT use the phrase 'I hope this email finds you well', 'I hope you're doing well', 'I hope this message finds you', 'Reaching out because…', or any similar opener-filler. Start with something specific.",
  "- Reference something concrete about the prospect's site when the domain name plausibly supports it (e.g. 'I noticed your contractor directory for the Tulsa area…'). If nothing concrete can be inferred, start with a direct, one-sentence reason for writing instead of faking specifics.",
  "- Keep every email short: 60–120 words. No walls of text.",
  "- First person, conversational tone. Contractions are fine. No corporate-speak ('synergies', 'leverage', 'in the space', 'best-in-class').",
  "- The ask must be specific and match the category's outreach angle (claim a listing, be added to a resource list, pitch an article, be included in a partner page).",
  "- Signature: use the partner's name ({{PartnerName}}) as the signing name; do NOT invent a person's name.",
  "- No AI disclaimers, no 'ChatGPT', no placeholders like '[Your Name]' — use {{PartnerName}} literally or the business name.",
  "",
  "Reply with a single JSON object — no markdown fences, no commentary.",
].join("\n")

function buildPrompt(body: ParsedBody): string {
  const { partner, prospect } = body
  const lines: string[] = []

  lines.push(`# Partner`)
  lines.push(`Business name: ${partner.name}`)
  lines.push(`Website: ${partner.website}`)
  lines.push(`Services:\n${partner.services}`)
  lines.push(`Service areas:\n${partner.serviceAreas}`)
  if (partner.partnerGoals)
    lines.push(`Goals for outreach:\n${partner.partnerGoals}`)
  if (partner.targetAudience)
    lines.push(`Target audience:\n${partner.targetAudience}`)

  lines.push("")
  lines.push(`# Prospect`)
  lines.push(`Domain: ${prospect.domain}`)
  lines.push(`Category: ${prospect.category}`)
  lines.push(`Outreach angle (you can refine this): ${prospect.angle}`)
  lines.push(`Why this category was chosen: ${prospect.reasoning}`)
  lines.push(
    `Competitor whose backlink profile this domain appeared in: ${prospect.referringTo}`,
  )
  lines.push(
    `DataForSEO rank (0-1000, higher = stronger authority): ${prospect.rank}`,
  )

  lines.push("")
  lines.push(`# Sequence design`)
  lines.push(
    `Write exactly 3 emails. Each follow-up must reference the thread naturally (no forwarded-email headers, no "Bumping this" cliché) and add a new angle or piece of value — don't just re-ask the same question.`,
  )
  lines.push(
    `- Email 1 (sendAfterDays: 0) — initial pitch. Lead with a specific observation about ${prospect.domain} or a clear reason for writing. Make the ask by the third sentence. Close with one concrete next step.`,
  )
  lines.push(
    `- Email 2 (sendAfterDays: 5) — first follow-up. Short (60–90 words). Add one new piece of context: a recent piece of work from ${partner.name}, a local angle, or a specific page on the prospect's site the ask would fit.`,
  )
  lines.push(
    `- Email 3 (sendAfterDays: 10) — break-up email. Acknowledge they're busy, restate the ask in one sentence, close the loop politely so they can say no without guilt. Under 80 words.`,
  )

  lines.push("")
  lines.push(`# Signing`)
  lines.push(
    `Sign every email with the business name "${partner.name}". Do NOT invent a first name for a fake contact person. Do NOT leave placeholders like "[Your Name]" or "[Company Name]". If a first-person signature is needed, write "— ${partner.name} team" or similar.`,
  )

  lines.push("")
  lines.push(`# Output format`)
  lines.push(
    `Output exactly one JSON object with an "emails" array of 3 entries, in send order. Each entry: { "subject": string, "body": string, "sendAfterDays": number }. The body should be plain text with \\n between paragraphs (no HTML). Do NOT wrap the JSON in code fences.`,
  )
  lines.push("")
  lines.push(`Example shape (content should NOT match this — use the partner and prospect above):`)
  lines.push("```")
  lines.push(`{`)
  lines.push(`  "emails": [`)
  lines.push(
    `    { "subject": "Quick question about your Tulsa contractor list", "body": "Hi there,\\n\\nRan across ... .\\n\\n— Example Business", "sendAfterDays": 0 },`,
  )
  lines.push(
    `    { "subject": "Re: Quick question about your Tulsa contractor list", "body": "Hi again,\\n\\n...", "sendAfterDays": 5 },`,
  )
  lines.push(
    `    { "subject": "Closing the loop", "body": "Hi —\\n\\nNo worries if ...", "sendAfterDays": 10 }`,
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

async function callClaudeForEmails(
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
    throw new Error(
      `Claude did not return valid JSON: ${err instanceof Error ? err.message : "unknown"}`,
    )
  }
  const result = claudeResponseSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(
      `Claude response did not match schema: ${result.error.message}`,
    )
  }
  return result.data
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

  const prompt = buildPrompt(parsed.data)
  try {
    let result: z.infer<typeof claudeResponseSchema>
    try {
      result = await callClaudeForEmails(prompt)
    } catch (firstErr) {
      console.warn(
        "[api/claude/outreach] first attempt failed, retrying once:",
        firstErr instanceof Error ? firstErr.message : firstErr,
      )
      const retryPrompt = `${prompt}\n\n# Retry note\nYour previous response was invalid: ${firstErr instanceof Error ? firstErr.message : "parse error"}. Output ONLY the JSON object described above — no markdown, no commentary.`
      result = await callClaudeForEmails(retryPrompt)
    }

    const emails: OutreachEmail[] = result.emails
      .slice()
      .sort((a, b) => a.sendAfterDays - b.sendAfterDays)
    return NextResponse.json({ emails })
  } catch (error: unknown) {
    console.error("[api/claude/outreach] failed:", error)
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
