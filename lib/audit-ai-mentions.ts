import "server-only"
import { aiModeSerpLive, aiOptimizationLive } from "@/lib/dataforseo-ai"
import { deriveBrandTokens } from "@/lib/branded-keywords"
import { DFS_LABS_COUNTRY_CODE_US, rankedKeywords } from "@/lib/dataforseo"
import type {
  AIMentionsReport,
  AIOverviewRow,
  AIPromptDefinition,
  AiPromptSource,
  LLMResponseRow,
  LlmProvider,
} from "@/lib/types"

/**
 * AI Search Mentions analyzer.
 *
 * Tests whether the prospect appears when buyers ask LLMs (ChatGPT,
 * Perplexity, Gemini, Claude) and Google's AI Mode for service
 * recommendations in their target markets. Output renders in the audit
 * dashboard as a dedicated "AI Search Visibility" section.
 *
 * The 8 LLM prompts are templated from `priorityServices` × first
 * `targetMarket`; the 10 AI Mode SERP keywords come from the prospect's
 * top-ranked keywords (DataForSEO Labs `ranked_keywords`). Mention detection
 * is brand-name + domain matching against the response text.
 *
 * Runs all calls in parallel with a per-provider concurrency cap to avoid
 * 429s. Per-call failures are recorded as `error` rows so a single LLM
 * outage doesn't tank the section.
 */

const PROVIDERS: LlmProvider[] = ["chat_gpt", "perplexity", "gemini", "claude"]

// Local templates — used when the prospect provided a target market. These
// are the strongest signal because LLM answers to local "best X in Y" queries
// surface named businesses very directly.
const LOCAL_PROMPT_TEMPLATES: string[] = [
  "What are the best {service} in {city}, {state}?",
  "Who is the top-rated {service} near {city}, {state}?",
  "Recommend a reliable {service} in {city}, {state}.",
  "How do I find a trustworthy {service} in {city}, {state}?",
  "Which {service} companies in {city}, {state} have the best reviews?",
  "Compare the leading {service} in {city}, {state}.",
  "I'm looking for a {service} in {city}, {state} — who should I call?",
  "Who are the most well-known {service} businesses in {city}, {state}?",
]

// Nationwide fallback templates — used when the prospect didn't provide a
// target market. Less actionable for local service businesses (LLMs will
// surface national chains) but still tests basic AI discoverability.
const NATIONAL_PROMPT_TEMPLATES: string[] = [
  "What are the best {service} companies in the United States?",
  "Who are the most reputable {service} providers nationwide?",
  "Recommend top-rated {service} companies.",
  "Which {service} companies have the strongest reputation?",
  "What are the leading {service} brands right now?",
  "Who are the most well-known {service} businesses?",
  "Compare the top {service} companies.",
  "What {service} companies should I consider working with?",
]

// Keyword-fallback templates — used when no priority services were provided
// and we fell back to top non-branded ranked keywords as the prompt slot.
// Ranked keywords can be long-tail phrases ("kitchen remodel atlanta cost")
// rather than clean service nouns, so these templates use {keyword} in
// grammatically forgiving positions instead of the "{service} in {city}"
// shape. Geo qualifier is dropped — geographic relevance is already
// implicit in the underlying keyword set.
const KEYWORD_FALLBACK_TEMPLATES: string[] = [
  "Who are the top providers for: {keyword}?",
  "Recommend a reputable company for: {keyword}.",
  "Who should I hire for: {keyword}?",
  "What are the best companies that handle: {keyword}?",
  "Compare top providers for: {keyword}.",
  "Recommended providers for: {keyword}.",
  "Top-rated services for: {keyword}.",
  "What companies specialize in: {keyword}?",
]

// Brand-discovery templates — last-resort fallback when the audit was run
// with literally just a domain (no services, no ranked keywords). These
// ask the LLMs about the company at {domain} directly. Detection semantics
// shift: "mentioned" no longer means "LLM cited the prospect among
// recommendations" (trivially true since the prompt is about them); it
// means "LLM provided substantive information about the brand." See
// `llmKnowsBrandFromText` below for the heuristic.
const BRAND_DISCOVERY_TEMPLATES: string[] = [
  "What can you tell me about the company at {domain}?",
  "Who runs the website {domain}?",
  "What services does the business at {domain} offer?",
  "Is {domain} a reputable business?",
  "Where is the company at {domain} based?",
  "What industry does {domain} operate in?",
  "How long has the business at {domain} been around?",
  "What is the company at {domain} best known for?",
]

// Phrases LLMs use when they don't recognize a brand. Used to flip the
// "mentioned" signal to false for brand-discovery prompts even though the
// brand string trivially appears (because we asked about it).
const NEGATIVE_KNOWLEDGE_PATTERNS: RegExp[] = [
  /i don'?t have (any |much |specific |reliable |detailed )?(information|details?|data|knowledge)/i,
  /i'?m not (familiar|aware|sure|certain)/i,
  /i don'?t (know|recognize|have a record)/i,
  /i (?:can'?t|cannot) (find|locate|verify|confirm)/i,
  /no (?:specific |reliable |verifiable )?information/i,
  /unable to (find|locate|provide|verify)/i,
  /i lack (?:specific |any )?(information|details|data|knowledge)/i,
  /(?:i'?m )?sorry,? (?:but )?i don'?t/i,
  /not (?:able to |something i can )?(?:find|provide|verify)/i,
]

const TARGET_PROMPT_COUNT = 8
const TARGET_KEYWORD_COUNT = 10
const PROVIDER_CONCURRENCY = 3

export interface AiMentionsInput {
  websiteUrl: string
  /** Prospect's brand name. Empty string is OK — falls back to domain. */
  partnerName: string
  priorityServices: string
  targetMarkets: { city: string; state: string }[]
  /** Optional competitor domains to cross-reference. */
  competitors?: string[]
  /** Set false to skip the LLM half (e.g., AI Optimization API not enabled). */
  enableLlms?: boolean
  /** Set false to skip the Google AI Mode SERP half. */
  enableAiMode?: boolean
}

export async function runAiMentions(
  input: AiMentionsInput,
): Promise<AIMentionsReport> {
  const startedAt = Date.now()
  const notes: string[] = []
  const enableLlms = input.enableLlms !== false
  const enableAiMode = input.enableAiMode !== false

  const brand = (input.partnerName || domainToBrand(input.websiteUrl)).trim()
  const brandTokens = deriveBrandTokens({
    partnerName: input.partnerName,
    websiteUrl: input.websiteUrl,
  })
  const competitorDomains = (input.competitors ?? [])
    .map(normalizeDomain)
    .filter((d): d is string => Boolean(d))

  // Inputs needed for both halves of the pipeline.
  const services = parseServices(input.priorityServices)
  const primaryMarket = input.targetMarkets[0] ?? null

  // ── Pull ranked keywords ───────────────────────────────────────────────
  // Used by the AI Mode SERP half AND as a fallback for LLM prompt slots
  // when no services were provided. We fetch eagerly (rather than only
  // when enableAiMode is true) so the keyword-fallback prompt path can
  // access them. Labs `ranked_keywords/live` rejects state- and city-level
  // `location_name` with status 40501 — Labs taxonomy is country-only
  // (verified live 2026-04-24, see lib/dataforseo.ts). Country-level here
  // still surfaces the prospect's actual top-ranking keywords, which is
  // what both the AI Mode probe seeds and the prompt fallback need.
  let nonBrandedRankedKeywords: string[] = []
  const needRankedKeywords =
    enableAiMode || (enableLlms && services.length === 0)
  if (needRankedKeywords) {
    try {
      const ranked = await rankedKeywords(
        normalizeDomain(input.websiteUrl) ?? input.websiteUrl,
        { code: DFS_LABS_COUNTRY_CODE_US },
        { limit: 50 },
      )
      nonBrandedRankedKeywords = dedupe(
        ranked.map((r) => r.keyword).filter((kw) => !isBranded(kw, brandTokens)),
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown"
      notes.push(`Could not fetch ranked keywords: ${msg}`)
    }
  }

  // ── Build prompt set (LLM half) ────────────────────────────────────────
  // Three branches, in priority order:
  //   1. Services provided → service-template prompts (LOCAL or NATIONAL).
  //   2. No services, but ranked keywords available → keyword-fallback prompts.
  //   3. Neither → skip LLM half (no noun to substitute).
  const prompts: AIPromptDefinition[] = []
  if (services.length > 0) {
    const templates = primaryMarket
      ? LOCAL_PROMPT_TEMPLATES
      : NATIONAL_PROMPT_TEMPLATES
    if (!primaryMarket) {
      notes.push(
        "No target market provided — testing nationwide LLM queries instead. Add a target location for local-results coverage.",
      )
    }
    let i = 0
    for (const tpl of templates) {
      const service = services[i % services.length]
      let prompt = tpl.replace("{service}", service)
      if (primaryMarket) {
        prompt = prompt
          .replace("{city}", primaryMarket.city)
          .replace("{state}", primaryMarket.state)
      }
      prompts.push({
        id: `tpl-${i}`,
        prompt,
        source: "service_template",
      })
      i++
      if (prompts.length >= TARGET_PROMPT_COUNT) break
    }
  } else if (nonBrandedRankedKeywords.length > 0) {
    notes.push(
      "No priority services provided — derived prompt topics from the prospect's top non-branded ranked keywords. Add explicit services for cleaner prompts.",
    )
    // Use the top 4 keywords to seed 8 prompts (each keyword gets 2 templates).
    const seedKeywords = nonBrandedRankedKeywords.slice(0, 4)
    let i = 0
    for (const tpl of KEYWORD_FALLBACK_TEMPLATES) {
      const keyword = seedKeywords[i % seedKeywords.length]
      prompts.push({
        id: `kw-${i}`,
        prompt: tpl.replace("{keyword}", keyword),
        source: "ranked_keyword",
        keyword,
      })
      i++
      if (prompts.length >= TARGET_PROMPT_COUNT) break
    }
  } else if (enableLlms) {
    // Final fallback — domain-only audit. Brand-discovery prompts ask LLMs
    // directly about the company at the domain. "Mentioned" detection
    // shifts to "did the LLM provide substantive info?" (see
    // llmResponseToRow's brand_discovery branch).
    notes.push(
      "No services and no ranked keywords — running brand-discovery prompts only. LLM responses were checked for whether the assistant could provide any substantive information about the prospect, not for whether the prospect was named in a recommendation.",
    )
    const apexDomain = normalizeDomain(input.websiteUrl) ?? input.websiteUrl
    let i = 0
    for (const tpl of BRAND_DISCOVERY_TEMPLATES) {
      prompts.push({
        id: `bd-${i}`,
        prompt: tpl.replace("{domain}", apexDomain),
        source: "brand_discovery",
      })
      i++
      if (prompts.length >= TARGET_PROMPT_COUNT) break
    }
  }

  // ── Select AI Mode SERP keyword set ────────────────────────────────────
  // Same source as the prompt fallback — top non-branded ranked keywords.
  const aiModeKeywords = enableAiMode
    ? nonBrandedRankedKeywords.slice(0, TARGET_KEYWORD_COUNT)
    : []

  // ── Run LLM calls (provider × prompt grid) ─────────────────────────────
  const llmResponses: LLMResponseRow[] = []
  if (enableLlms && prompts.length > 0) {
    const userLocation = primaryMarket
      ? `${primaryMarket.city}, ${primaryMarket.state}`
      : undefined
    const tasks: Array<{
      provider: LlmProvider
      prompt: AIPromptDefinition
    }> = []
    for (const provider of PROVIDERS) {
      for (const prompt of prompts) tasks.push({ provider, prompt })
    }
    // Concurrency-limited fan-out, grouped by provider so a slow provider
    // doesn't starve faster ones.
    const byProvider = groupBy(tasks, (t) => t.provider)
    const providerRuns = await Promise.all(
      Object.values(byProvider).map(async (items) => {
        return runWithConcurrency(items, PROVIDER_CONCURRENCY, async (t) => {
          try {
            const res = await aiOptimizationLive({
              provider: t.provider,
              prompt: t.prompt.prompt,
              userLocation,
            })
            return llmResponseToRow({
              provider: t.provider as LlmProvider,
              promptId: t.prompt.id,
              promptSource: t.prompt.source,
              text: res.text,
              citedDomains: res.citedDomains,
              costUsd: res.costUsd,
              brand,
              brandTokens,
              websiteUrl: input.websiteUrl,
              competitorDomains,
            })
          } catch (err) {
            const msg = err instanceof Error ? err.message : "unknown error"
            return {
              promptId: t.prompt.id,
              provider: t.provider as LlmProvider,
              responseText: "",
              mentioned: false,
              competitorMentions: [],
              citedDomains: [],
              costUsd: 0,
              error: msg,
            } satisfies LLMResponseRow
          }
        })
      }),
    )
    for (const arr of providerRuns) llmResponses.push(...arr)
  } else if (!enableLlms) {
    notes.push("LLM responses disabled by caller.")
  }

  // ── Run Google AI Mode SERP probes ─────────────────────────────────────
  // Location strategy:
  //   - With a market: try city → fall back to state on DFSEO rejection.
  //   - Without a market: nationwide ("United States") for all probes.
  const aiOverviewRows: AIOverviewRow[] = []
  if (enableAiMode && aiModeKeywords.length > 0) {
    const displayLocation = primaryMarket
      ? locationLabel(primaryMarket)
      : "United States"
    const initialLocation = primaryMarket
      ? `${primaryMarket.city},${primaryMarket.state},United States`
      : "United States"
    const fallbackLocation = primaryMarket
      ? `${primaryMarket.state},United States`
      : "United States"
    let useLocation = initialLocation
    let probeFailed = false
    try {
      const probe = await aiModeSerpLive({
        keyword: aiModeKeywords[0],
        locationName: initialLocation,
      })
      aiOverviewRows.push(
        aiModeRowFromResult({
          keyword: aiModeKeywords[0],
          location: displayLocation,
          result: probe,
          websiteUrl: input.websiteUrl,
          competitorDomains,
        }),
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown"
      if (primaryMarket && /40501|location/i.test(msg)) {
        useLocation = fallbackLocation
        notes.push(
          `Google AI Mode rejected city "${primaryMarket.city}", falling back to ${primaryMarket.state} state-level.`,
        )
      } else {
        notes.push(`AI Mode probe failed for "${aiModeKeywords[0]}": ${msg}`)
        probeFailed = true
      }
    }

    const remaining = aiModeKeywords.slice(1)
    if (remaining.length > 0 && !probeFailed) {
      const rows = await runWithConcurrency(remaining, 4, async (kw) => {
        try {
          const res = await aiModeSerpLive({
            keyword: kw,
            locationName: useLocation,
          })
          return aiModeRowFromResult({
            keyword: kw,
            location: displayLocation,
            result: res,
            websiteUrl: input.websiteUrl,
            competitorDomains,
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : "unknown"
          return {
            keyword: kw,
            location: displayLocation,
            hasAiOverview: false,
            prospectMentioned: false,
            citedDomains: [],
            competitorMentions: [],
            costUsd: 0,
            error: msg,
          } satisfies AIOverviewRow
        }
      })
      aiOverviewRows.push(...rows)
    }
  }

  // ── Aggregate ──────────────────────────────────────────────────────────
  const llmMentionCount = llmResponses.filter((r) => r.mentioned).length
  const aiOverviewPresentCount = aiOverviewRows.filter((r) => r.hasAiOverview).length
  const aiOverviewMentionCount = aiOverviewRows.filter((r) => r.prospectMentioned).length

  const perProviderMentionRate = PROVIDERS.reduce(
    (acc, provider) => {
      const calls = llmResponses.filter((r) => r.provider === provider && !r.error)
      acc[provider] =
        calls.length > 0
          ? calls.filter((r) => r.mentioned).length / calls.length
          : 0
      return acc
    },
    {} as Record<LlmProvider, number>,
  )

  const competitorCounts = new Map<string, number>()
  for (const r of llmResponses) {
    for (const d of r.competitorMentions) {
      competitorCounts.set(d, (competitorCounts.get(d) ?? 0) + 1)
    }
  }
  for (const r of aiOverviewRows) {
    for (const d of r.competitorMentions) {
      competitorCounts.set(d, (competitorCounts.get(d) ?? 0) + 1)
    }
  }
  const topCompetitorMentions = [...competitorCounts.entries()]
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)

  const costUsd =
    llmResponses.reduce((s, r) => s + r.costUsd, 0) +
    aiOverviewRows.reduce((s, r) => s + r.costUsd, 0)

  return {
    prospectDomain: normalizeDomain(input.websiteUrl) ?? input.websiteUrl,
    prospectBrand: brand,
    brandTokens,
    competitorDomains,
    prompts,
    llmResponses,
    aiOverviewRows,
    totals: {
      promptCount: prompts.length,
      llmCallCount: llmResponses.length,
      llmMentionCount,
      aiOverviewKeywordCount: aiOverviewRows.length,
      aiOverviewPresentCount,
      aiOverviewMentionCount,
      perProviderMentionRate,
      topCompetitorMentions,
    },
    costUsd,
    durationSeconds: Math.round((Date.now() - startedAt) / 1000),
    notes,
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function llmResponseToRow(opts: {
  provider: LlmProvider
  promptId: string
  promptSource: AiPromptSource
  text: string
  citedDomains: string[]
  costUsd: number
  brand: string
  brandTokens: string[]
  websiteUrl: string
  competitorDomains: string[]
}): LLMResponseRow {
  const apex = normalizeDomain(opts.websiteUrl) ?? ""
  const haystack = opts.text.toLowerCase()

  // For brand_discovery prompts, "mentioned" semantics shift: we asked
  // about the brand by name, so a verbatim match is trivially true. The
  // useful signal is whether the LLM produced substantive info vs. saying
  // it doesn't recognize the brand. For service/keyword prompts, fall
  // through to the standard discoverability check.
  const mentioned =
    opts.promptSource === "brand_discovery"
      ? llmKnowsBrandFromText(opts.text)
      : matchesBrand(haystack, opts.brand, opts.brandTokens) ||
        (apex.length > 0 && haystack.includes(apex)) ||
        opts.citedDomains.includes(apex)

  const competitorMentions = uniqueCompetitorMatches({
    text: haystack,
    citedDomains: opts.citedDomains,
    competitors: opts.competitorDomains,
  })

  return {
    promptId: opts.promptId,
    provider: opts.provider,
    responseText: opts.text.slice(0, 4000),
    mentioned,
    competitorMentions,
    citedDomains: opts.citedDomains,
    costUsd: opts.costUsd,
  }
}

/**
 * Heuristic check for whether an LLM response demonstrates awareness of the
 * brand. Used for brand_discovery prompts where "did the LLM mention the
 * brand?" is trivially true (we asked about it). True signal: does the
 * response contain a refusal/uncertainty phrase, or is it short and empty?
 */
function llmKnowsBrandFromText(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 60) return false
  for (const re of NEGATIVE_KNOWLEDGE_PATTERNS) {
    if (re.test(trimmed)) return false
  }
  return true
}

function aiModeRowFromResult(opts: {
  keyword: string
  location: string
  result: { hasAiOverview: boolean; citedDomains: string[]; costUsd: number }
  websiteUrl: string
  competitorDomains: string[]
}): AIOverviewRow {
  const apex = normalizeDomain(opts.websiteUrl) ?? ""
  const prospectMentioned =
    apex.length > 0 && opts.result.citedDomains.includes(apex)
  const competitorMentions = uniqueCompetitorMatches({
    text: "",
    citedDomains: opts.result.citedDomains,
    competitors: opts.competitorDomains,
  })
  return {
    keyword: opts.keyword,
    location: opts.location,
    hasAiOverview: opts.result.hasAiOverview,
    prospectMentioned,
    citedDomains: opts.result.citedDomains,
    competitorMentions,
    costUsd: opts.result.costUsd,
  }
}

function uniqueCompetitorMatches(opts: {
  text: string
  citedDomains: string[]
  competitors: string[]
}): string[] {
  const out = new Set<string>()
  for (const c of opts.competitors) {
    if (opts.citedDomains.includes(c)) out.add(c)
    else if (opts.text && opts.text.includes(c)) out.add(c)
  }
  return [...out]
}

function matchesBrand(
  haystackLower: string,
  brand: string,
  brandTokens: string[],
): boolean {
  const b = brand.trim().toLowerCase()
  if (b.length >= 3 && haystackLower.includes(b)) return true
  // Multi-word brand: require all tokens to appear close-ish (looser word
  // match — generic single-word brands like "Acme" need every token).
  if (brandTokens.length === 0) return false
  for (const tok of brandTokens) {
    if (tok.length < 3) continue
    if (!haystackLower.includes(tok)) return false
  }
  return brandTokens.some((t) => t.length >= 3)
}

function isBranded(keyword: string, brandTokens: string[]): boolean {
  if (brandTokens.length === 0) return false
  const lower = keyword.toLowerCase()
  return brandTokens.some((t) => t.length >= 3 && lower.includes(t))
}

function parseServices(raw: string): string[] {
  return raw
    .split(/[,\n;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 8)
}

function domainToBrand(websiteUrl: string): string {
  const apex = normalizeDomain(websiteUrl) ?? websiteUrl
  const root = apex.split(".")[0] ?? apex
  return root
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
}

function normalizeDomain(raw: string): string | null {
  if (!raw) return null
  try {
    const u = new URL(raw.startsWith("http") ? raw : `https://${raw}`)
    return u.hostname.replace(/^www\./, "").toLowerCase()
  } catch {
    return raw.replace(/^https?:\/\//, "").replace(/^www\./, "").toLowerCase()
  }
}

function locationLabel(m: { city: string; state: string }): string {
  return `${m.city}, ${m.state}`
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)]
}

function groupBy<T, K extends string>(arr: T[], key: (t: T) => K): Record<K, T[]> {
  const out = {} as Record<K, T[]>
  for (const t of arr) {
    const k = key(t)
    if (!out[k]) out[k] = []
    out[k].push(t)
  }
  return out
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return out
}
