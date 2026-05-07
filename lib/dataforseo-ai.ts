import "server-only"
import { z } from "zod"
import { dfsRequest, DataForSEOError } from "@/lib/dataforseo"
import type { LlmProvider } from "@/lib/types"

/**
 * DataForSEO **AI Optimization API** + **Google AI Mode SERP** wrappers.
 *
 * These two surfaces feed the audit's AI Search Mentions section. Both share
 * the existing `dfsRequest` transport from `lib/dataforseo.ts` so they pick up
 * Basic auth, 429 retry, envelope validation, and `recordDataForSEOCost()`
 * accumulation for free.
 *
 * Schemas use `.passthrough()` and `.optional()` aggressively because the
 * documented response shape for both endpoints is best-effort and DataForSEO
 * occasionally adds fields without notice. We narrow only on the fields we
 * actually consume downstream.
 *
 * Cost (rough, mid-2025 pricing): AI Optimization is ~$0.005-$0.02 per LLM
 * call; AI Mode SERP is ~$0.001 per keyword. Real per-audit cost is reported
 * by `lib/audit-cost.ts` via the same envelope.cost path everything else uses.
 */

// ── AI Optimization API ──────────────────────────────────────────────────

/**
 * Endpoint path per provider. The AI Optimization namespace separates the
 * four LLMs into distinct endpoints rather than a single `provider` param.
 *
 * If DFSEO renames or splits these, this is the only place to update.
 */
const AI_OPTIMIZATION_ENDPOINTS: Record<LlmProvider, string> = {
  chat_gpt: "/v3/ai_optimization/chat_gpt/llm_responses/live",
  perplexity: "/v3/ai_optimization/perplexity/llm_responses/live",
  gemini: "/v3/ai_optimization/gemini/llm_responses/live",
  claude: "/v3/ai_optimization/claude/llm_responses/live",
}

/**
 * Whether the LLM should browse the live web for the answer. ChatGPT and
 * Perplexity essentially require it for "search-grounded" responses;
 * Gemini benefits; Claude (via DFSEO) historically doesn't expose web
 * browsing so we leave it off there.
 */
const PROVIDER_WEB_SEARCH: Record<LlmProvider, boolean> = {
  chat_gpt: true,
  perplexity: true,
  gemini: true,
  claude: false,
}

/**
 * Loose item shape — DFSEO's AI Optimization response wraps the LLM answer
 * in `items[].sections[].text` (sometimes flattened to `items[].message`).
 * We try both shapes and union the text we extract.
 */
const aiOptimizationItemSchema = z
  .object({
    type: z.string().optional(),
    text: z.string().optional(),
    message: z.string().optional(),
    annotations: z
      .array(
        z
          .object({
            url: z.string().optional(),
            cited_url: z.string().optional(),
            title: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
    sections: z
      .array(
        z
          .object({
            text: z.string().optional(),
            type: z.string().optional(),
            citations: z
              .array(
                z
                  .object({
                    url: z.string().optional(),
                    title: z.string().optional(),
                  })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
    citations: z
      .array(
        z
          .object({
            url: z.string().optional(),
            cited_url: z.string().optional(),
            title: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough()

type AiOptimizationItem = z.infer<typeof aiOptimizationItemSchema>

export interface AiOptimizationResult {
  /** Concatenated text content extracted from the response, defensively. */
  text: string
  /** Distinct hostnames cited as sources (lowercased, no scheme). */
  citedDomains: string[]
  /** Cost of this single call (from envelope.cost). */
  costUsd: number
}

/**
 * Live LLM call. One prompt → one response. Returns extracted text + cited
 * domains so the caller can do mention detection.
 *
 * `userLocation` (e.g. "Atlanta, Georgia") is sent verbatim so the LLM can
 * scope local results when the prompt asks for "near me" / city-specific
 * recommendations. DFSEO's AI Optimization endpoints accept it as part of
 * the prompt context; if the API rejects it we fall back to omitting.
 */
export async function aiOptimizationLive(opts: {
  provider: LlmProvider
  prompt: string
  userLocation?: string
}): Promise<AiOptimizationResult> {
  const endpoint = AI_OPTIMIZATION_ENDPOINTS[opts.provider]
  const body = [
    {
      user_prompt: opts.prompt,
      web_search: PROVIDER_WEB_SEARCH[opts.provider],
      // Optional fields — DFSEO ignores unknown fields silently in our
      // experience, but we only set what we mean.
      ...(opts.userLocation ? { user_location: opts.userLocation } : {}),
    },
  ]

  const envelope = await dfsRequest<{
    cost?: number
    tasks?: Array<{
      cost?: number
      result?: Array<unknown> | null
    }>
  }>(endpoint, body)

  const taskCost =
    envelope.tasks?.[0]?.cost ?? envelope.cost ?? 0
  const result = envelope.tasks?.[0]?.result?.[0] as unknown
  if (!result || typeof result !== "object") {
    return { text: "", citedDomains: [], costUsd: taskCost }
  }

  // The result envelope sometimes nests `items` and sometimes returns the
  // payload directly with `message`/`text`. Handle both.
  const resultObj = result as { items?: unknown }
  const itemsRaw = Array.isArray(resultObj.items)
    ? resultObj.items
    : [resultObj]

  const textParts: string[] = []
  const cited = new Set<string>()
  for (const raw of itemsRaw) {
    const parsed = aiOptimizationItemSchema.safeParse(raw)
    if (!parsed.success) continue
    collectFromItem(parsed.data, textParts, cited)
  }

  return {
    text: textParts.join("\n").trim(),
    citedDomains: [...cited],
    costUsd: taskCost,
  }
}

function collectFromItem(
  item: AiOptimizationItem,
  textParts: string[],
  cited: Set<string>,
): void {
  if (item.text) textParts.push(item.text)
  if (item.message) textParts.push(item.message)
  for (const section of item.sections ?? []) {
    if (section.text) textParts.push(section.text)
    for (const c of section.citations ?? []) {
      const host = hostFromUrl(c.url)
      if (host) cited.add(host)
    }
  }
  for (const a of item.annotations ?? []) {
    const host = hostFromUrl(a.url ?? a.cited_url)
    if (host) cited.add(host)
  }
  for (const c of item.citations ?? []) {
    const host = hostFromUrl(c.url ?? c.cited_url)
    if (host) cited.add(host)
  }
}

// ── Google AI Mode SERP ───────────────────────────────────────────────────
//
// `/v3/serp/google/ai_mode/live/advanced` returns Google's AI-mode answer for
// a query, including the AI Overview block when one is shown for the regular
// Google SERP. Items array contains an `ai_mode` (or `ai_overview`) element
// with `references[]` listing the cited source URLs.

const aiModeReferenceSchema = z
  .object({
    url: z.string().optional(),
    domain: z.string().optional(),
    title: z.string().optional(),
    source: z.string().optional(),
  })
  .passthrough()

const aiModeItemSchema = z
  .object({
    type: z.string().optional(),
    text: z.string().optional(),
    references: z.array(aiModeReferenceSchema).optional(),
    items: z
      .array(
        z
          .object({
            references: z.array(aiModeReferenceSchema).optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough()

export interface AiModeSerpResult {
  hasAiOverview: boolean
  citedDomains: string[]
  costUsd: number
}

/**
 * Single keyword × location AI Mode SERP probe. `locationName` should be a
 * DataForSEO-canonical Google Ads location (e.g. "Atlanta,Georgia,United States"
 * — note: no spaces around commas). If you only have city-level ("Atlanta, GA")
 * format, run it through `parseLocationLine` from `lib/locations.ts` first.
 */
export async function aiModeSerpLive(opts: {
  keyword: string
  locationName: string
  languageCode?: string
}): Promise<AiModeSerpResult> {
  const body = [
    {
      keyword: opts.keyword,
      location_name: opts.locationName,
      language_code: opts.languageCode ?? "en",
      device: "desktop" as const,
    },
  ]

  let envelope: {
    cost?: number
    tasks?: Array<{
      cost?: number
      result?: Array<{ items?: unknown[] | null }> | null
    }>
  }
  try {
    envelope = await dfsRequest("/v3/serp/google/ai_mode/live/advanced", body)
  } catch (err) {
    // 40501 / "Not Found" responses on AI Mode SERP usually mean the keyword
    // didn't trigger an AI Overview rather than a real error — but DFSEO
    // doesn't make that distinction reliably. Surface the error to the
    // caller so it can be recorded per-row.
    throw err instanceof DataForSEOError
      ? err
      : new DataForSEOError(
          `AI Mode SERP failed: ${err instanceof Error ? err.message : "unknown"}`,
        )
  }

  const taskCost = envelope.tasks?.[0]?.cost ?? envelope.cost ?? 0
  const items = envelope.tasks?.[0]?.result?.[0]?.items ?? []

  let hasAi = false
  const cited = new Set<string>()
  for (const raw of items) {
    const parsed = aiModeItemSchema.safeParse(raw)
    if (!parsed.success) continue
    const item = parsed.data
    const looksAi =
      item.type === "ai_overview" ||
      item.type === "ai_mode" ||
      (Array.isArray(item.references) && item.references.length > 0)
    if (looksAi) hasAi = true
    for (const ref of item.references ?? []) {
      const host = hostFromUrl(ref.url) ?? normalizeDomain(ref.domain)
      if (host) cited.add(host)
    }
    for (const sub of item.items ?? []) {
      for (const ref of sub.references ?? []) {
        const host = hostFromUrl(ref.url) ?? normalizeDomain(ref.domain)
        if (host) cited.add(host)
      }
    }
  }

  return {
    hasAiOverview: hasAi,
    citedDomains: [...cited],
    costUsd: taskCost,
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function hostFromUrl(url: string | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`)
    return u.hostname.replace(/^www\./, "").toLowerCase()
  } catch {
    return null
  }
}

function normalizeDomain(domain: string | undefined): string | null {
  if (!domain) return null
  return domain.replace(/^https?:\/\//, "").replace(/^www\./, "").toLowerCase()
}
