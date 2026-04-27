import "server-only"
import { NextResponse } from "next/server"
import Anthropic from "@anthropic-ai/sdk"
import { z } from "zod"
import { ClaudeApiError, DEFAULT_MODEL } from "@/lib/claude"
import { requireEnv } from "@/lib/env"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(20000),
})

const pageContextSchema = z
  .object({
    tab: z.string().max(80).optional(),
    pathname: z.string().max(200).optional(),
    summary: z.string().max(8000).optional(),
    data: z.unknown().optional(),
  })
  .optional()

const bodySchema = z.object({
  messages: z.array(messageSchema).min(1).max(40),
  pageContext: pageContextSchema,
})

const SYSTEM_BASE = `You are an embedded assistant inside the Harbinger SEO Tool — an internal app the SEO engineer at Harbinger Marketing uses to run a 6-month SEO cycle for ~100 local service business partners.

The tool has these tabs:
- Audit (pre-sales: prospect domain → crawl + DataForSEO + optional GSC/GA4 → polished PDF for sales)
- Comp Analysis (pre-sales: competitor SERP visibility per market)
- Strategy (approved keywords + partner profile → 6-month strategy doc)
- Content (page brief → technical package + body copy with JSON-LD validation)
- Backlinks (competitor domains → DataForSEO backlinks → outreach drafts)
- Reporting (partner + date range → GSC + GA4 narrative report)
- Keyword Research (GSC queries + DataForSEO volume/difficulty → scored list)

Answer the user's questions in the context of whatever tab they're on. Be specific and concrete — reference real values from the page context when relevant. If the page context is empty for the current tab, it's because the user hasn't run anything yet on that tab. Don't make up data. If you need information not in the context to answer well, ask for it.

Style: terse, technical, no fluff. Markdown is fine. No emoji unless the user uses them first. No "Great question!" preambles.`

function buildSystemPrompt(pageContext: z.infer<typeof pageContextSchema>): string {
  if (!pageContext) return SYSTEM_BASE
  const parts: string[] = [SYSTEM_BASE, ""]
  parts.push("## Current page context")
  if (pageContext.tab) parts.push(`Tab: ${pageContext.tab}`)
  if (pageContext.pathname) parts.push(`Pathname: ${pageContext.pathname}`)
  if (pageContext.summary) {
    parts.push("")
    parts.push(pageContext.summary)
  }
  if (pageContext.data !== undefined) {
    let serialized: string
    try {
      serialized = JSON.stringify(pageContext.data, null, 2)
    } catch {
      serialized = String(pageContext.data)
    }
    if (serialized.length > 12000) {
      serialized = serialized.slice(0, 12000) + "\n…[truncated]"
    }
    parts.push("")
    parts.push("Structured data on this page:")
    parts.push("```json")
    parts.push(serialized)
    parts.push("```")
  }
  return parts.join("\n")
}

let cachedClient: Anthropic | null = null
function getClient(): Anthropic {
  if (cachedClient) return cachedClient
  cachedClient = new Anthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY") })
  return cachedClient
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

  const { messages, pageContext } = parsed.data
  if (messages[messages.length - 1].role !== "user") {
    return NextResponse.json(
      { error: "Last message must come from the user" },
      { status: 400 },
    )
  }

  const system = buildSystemPrompt(pageContext)

  try {
    const client = getClient()
    const stream = client.messages.stream({
      model: DEFAULT_MODEL,
      max_tokens: 2048,
      system,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    })
    const response = await stream.finalMessage()
    const textBlocks = response.content.filter(
      (b): b is Anthropic.TextBlock => b.type === "text",
    )
    if (textBlocks.length === 0) {
      throw new ClaudeApiError(
        `Anthropic returned no text content (stop_reason=${response.stop_reason})`,
        undefined,
      )
    }
    const reply = textBlocks.map((b) => b.text).join("")
    return NextResponse.json({
      reply,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    })
  } catch (error: unknown) {
    console.error("[api/claude/chat] failed:", error)
    if (error instanceof Anthropic.APIError) {
      return NextResponse.json(
        { error: `Anthropic API error: ${error.message}` },
        { status: error.status ?? 502 },
      )
    }
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
