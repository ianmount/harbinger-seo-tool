import "server-only"
import { z } from "zod"
import { callClaudeDetailed, ClaudeApiError } from "@/lib/claude"
import { flattenSitemap, urlFor } from "@/lib/sitemap-parser"
import type {
  InitialStrategyOutput,
  InternalLink,
  KeywordMapping,
  Partner,
  RedirectType,
  SitemapNode,
  UrlMapping,
} from "@/lib/types"

/**
 * Initial Strategy workflow — single Opus 4.7 call that produces three
 * coordinated outputs (keyword-to-page mapping, current→new URL mapping,
 * internal-linking plan) for a Partner's new-site build.
 *
 * One call, not three: the outputs cross-reference each other (Claude needs
 * to know which page won which primary keyword before recommending internal
 * link anchor text), and a single coherent reasoning step is much more likely
 * to produce internally consistent output than three independent calls.
 *
 * Claude refers to pages by their breadcrumb `path` from the parsed sitemap
 * — never by URL, never by free-text page names. The server resolves paths
 * back to nodes via a Map and fills in `pageName` / `newUrl` post-hoc, so
 * one source of truth for URLs (the sitemap parser).
 */

const STRATEGY_MODEL = "claude-opus-4-7"
const STRATEGY_MAX_TOKENS = 32_000

const SYSTEM_PROMPT =
  "You are a senior SEO strategist planning a new site build for a local service business. You produce concrete, internally consistent strategy: every primary keyword you assign appears in the approved list verbatim, every page you reference exists in the approved sitemap (by path), every redirect target is a real new page or null. You output exactly one JSON object that matches the schema given to you — no preamble, no explanation, no markdown fences."

const claudeKeywordSchema = z.object({
  pagePath: z.string().min(1),
  primaryKeyword: z.string().min(1),
  secondaryKeywords: z.array(z.string().min(1)).max(15).default([]),
  rationale: z.string().min(1),
})

const claudeUrlSchema = z.object({
  oldUrl: z.string().min(1),
  targetPagePath: z.string().nullable(),
  redirectType: z.enum(["301", "none"]),
  notes: z.string().default(""),
})

const claudeLinkSchema = z.object({
  sourcePagePath: z.string().min(1),
  targetPagePath: z.string().min(1),
  anchorText: z.string().min(1),
  rationale: z.string().min(1),
})

const claudeOutputSchema = z.object({
  keywordMapping: z.array(claudeKeywordSchema),
  urlMapping: z.array(claudeUrlSchema),
  internalLinking: z.array(claudeLinkSchema),
})

type ClaudeOutput = z.infer<typeof claudeOutputSchema>

export interface RunInitialStrategyParams {
  partner: Partner
  sitemapRoot: SitemapNode
  /** Original indented text — preserved for the prompt for shape clarity. */
  sitemapRawText: string
  keywords: string[]
  /** Absolute URLs crawled from the current site. */
  crawledUrls: string[]
}

export interface RunInitialStrategyResult {
  output: InitialStrategyOutput
  warnings: string[]
}

/**
 * Strip ```json ... ``` fences if Claude emits them despite being instructed
 * not to. Belt-and-suspenders — the prompt says no fences but we've seen
 * Claude wrap output in fences when it's unsure.
 */
function unwrapJsonFences(text: string): string {
  const trimmed = text.trim()
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i)
  if (fence) return fence[1].trim()
  return trimmed
}

function buildPrompt(params: RunInitialStrategyParams): string {
  const { partner, sitemapRoot, sitemapRawText, keywords, crawledUrls } = params
  const lines: string[] = []

  lines.push("# Partner profile")
  lines.push(`Name: ${partner.name}`)
  lines.push(`Website: ${partner.website}`)
  lines.push(`Services:\n${partner.services}`)
  lines.push(`Service areas:\n${partner.serviceAreas}`)
  if (partner.partnerGoals) lines.push(`Partner goals:\n${partner.partnerGoals}`)
  if (partner.targetAudience)
    lines.push(`Target audience:\n${partner.targetAudience}`)
  if (partner.industryKnowledge)
    lines.push(`Industry knowledge:\n${partner.industryKnowledge}`)

  lines.push("")
  lines.push("# Approved sitemap (raw input)")
  lines.push("```")
  lines.push(sitemapRawText.trim())
  lines.push("```")

  lines.push("")
  lines.push("# Approved sitemap (parsed — these are the canonical page paths)")
  lines.push(
    "Reference pages by the `path` shown below. The `proposedUrl` column is the URL slug already derived from the page name; you may suggest overrides via the `newUrl` field on individual rows where SEO requires it.",
  )
  lines.push("")
  for (const node of flattenSitemap(sitemapRoot)) {
    const indent = "  ".repeat(node.depth - 1)
    lines.push(`${indent}- path="${node.path}"  proposedUrl=${urlFor(node)}`)
  }

  lines.push("")
  lines.push(
    `# Approved keyword list (${keywords.length} keywords; use ONLY these as primary keywords)`,
  )
  for (const kw of keywords) lines.push(`- ${kw}`)

  lines.push("")
  lines.push(
    `# Current site URLs crawled (${crawledUrls.length} URLs; map each to a new sitemap page or flag as no-redirect)`,
  )
  for (const url of crawledUrls) lines.push(`- ${url}`)

  lines.push("")
  lines.push("# Task")
  lines.push(
    "Produce three coordinated strategy outputs for the new site build:",
  )
  lines.push("")
  lines.push("## 1. Keyword-to-page mapping")
  lines.push(
    "For each page in the approved sitemap, choose ONE primary keyword from the approved list — the keyword the page should rank #1 for. Pick supporting secondary keywords (2-6) from the approved list that the same page should naturally cover. Each primary keyword must be used on AT MOST one page; secondaries may repeat across pages when topically appropriate. If a sitemap page has no good primary in the list, omit it from `keywordMapping` (and call it out in your rationale on a related page or in the URL mapping notes).",
  )
  lines.push("")
  lines.push("## 2. URL mapping")
  lines.push(
    "For EVERY current-site URL listed above, decide which new sitemap page it should redirect to and emit one row. `targetPagePath` must equal one of the approved sitemap paths exactly, or null when no redirect is appropriate (page is being retired, content already lives at parent page, etc.). Use redirectType \"301\" for any non-null target, \"none\" when targetPagePath is null. Notes should be one short sentence explaining the call when it isn't obvious — particularly for retired pages.",
  )
  lines.push("")
  lines.push("## 3. Internal linking plan")
  lines.push(
    "For each new sitemap page, recommend 2-5 outgoing internal links to other sitemap pages. Cross-section is encouraged: homepage links to top service pages, service pages cross-link to related services, blog/resource pages link up to relevant service pages, location pages link to services offered there, etc. Anchor text should be natural and varied — mix exact-match (a page's primary keyword), partial-match, and descriptive phrases. Avoid identical anchor text on multiple links to the same target. The same source/target pair should appear at most once.",
  )

  lines.push("")
  lines.push("# Output schema")
  lines.push("Return ONLY a JSON object matching this TypeScript shape:")
  lines.push("```typescript")
  lines.push(`{
  "keywordMapping": [
    {
      "pagePath": string,           // exact path from approved sitemap
      "primaryKeyword": string,     // verbatim from approved list
      "secondaryKeywords": string[],// 2-6 entries, verbatim from approved list
      "rationale": string           // one sentence; cite intent or volume signal
    }
  ],
  "urlMapping": [
    {
      "oldUrl": string,             // verbatim from crawled URLs
      "targetPagePath": string | null, // exact path, or null when retiring
      "redirectType": "301" | "none",
      "notes": string               // one short sentence; can be empty
    }
  ],
  "internalLinking": [
    {
      "sourcePagePath": string,     // exact path from approved sitemap
      "targetPagePath": string,     // exact path; must differ from source
      "anchorText": string,         // the literal text inside <a>
      "rationale": string           // one sentence; topical or user-flow reason
    }
  ]
}`)
  lines.push("```")

  lines.push("")
  lines.push("# Hard rules")
  lines.push(
    "- Output ONE JSON object only. No prose before or after, no markdown fences.",
  )
  lines.push(
    "- Every `pagePath` / `targetPagePath` / `sourcePagePath` MUST match a path from the parsed sitemap above exactly (case + whitespace).",
  )
  lines.push(
    "- Every `primaryKeyword` MUST appear verbatim in the approved keyword list.",
  )
  lines.push(
    "- Every `oldUrl` MUST appear verbatim in the crawled URLs list.",
  )
  lines.push(
    "- One primary keyword maps to at most one page. Don't reuse a primary across pages.",
  )
  lines.push(
    "- Internal linking: source and target must differ. No duplicate (source, target) pairs.",
  )

  return lines.join("\n")
}

function findFirstJsonObject(text: string): string | null {
  // Scan for the first `{` and find its matching `}` while respecting strings.
  const start = text.indexOf("{")
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (escape) {
      escape = false
      continue
    }
    if (inString) {
      if (c === "\\") escape = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      continue
    }
    if (c === "{") depth++
    else if (c === "}") {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

function parseClaudeOutput(text: string): ClaudeOutput {
  const unwrapped = unwrapJsonFences(text)
  const candidate = findFirstJsonObject(unwrapped) ?? unwrapped
  let json: unknown
  try {
    json = JSON.parse(candidate)
  } catch (err) {
    throw new Error(
      `Claude returned non-JSON output: ${
        err instanceof Error ? err.message : "parse failed"
      }`,
    )
  }
  const result = claudeOutputSchema.safeParse(json)
  if (!result.success) {
    throw new Error(
      `Claude output failed schema validation: ${result.error.message}`,
    )
  }
  return result.data
}

/** Resolve a Claude-emitted path against the parsed tree. Returns null when
 * the path doesn't match anything (the row is dropped and a warning logged). */
function buildPathIndex(
  root: SitemapNode,
): Map<string, SitemapNode> {
  const map = new Map<string, SitemapNode>()
  for (const node of flattenSitemap(root)) {
    map.set(node.path, node)
  }
  return map
}

export async function runInitialStrategy(
  params: RunInitialStrategyParams,
): Promise<RunInitialStrategyResult> {
  const { partner, sitemapRoot, keywords, crawledUrls } = params
  const prompt = buildPrompt(params)
  const pathIndex = buildPathIndex(sitemapRoot)
  const keywordSet = new Set(keywords.map((k) => k.toLowerCase()))
  const crawledSet = new Set(crawledUrls)
  const warnings: string[] = []

  const startedAt = Date.now()
  const claudeResult = await callClaudeDetailed(prompt, {
    model: STRATEGY_MODEL,
    maxTokens: STRATEGY_MAX_TOKENS,
    system: SYSTEM_PROMPT,
  }).catch((err: unknown) => {
    if (err instanceof ClaudeApiError) throw err
    if (err instanceof Error) throw err
    throw new Error("Unknown Claude error")
  })

  const parsed = parseClaudeOutput(claudeResult.text)

  // Resolve & validate keyword mapping.
  const usedPrimaries = new Set<string>()
  const keywordMapping: KeywordMapping[] = []
  const claimedPagePaths = new Set<string>()
  for (const row of parsed.keywordMapping) {
    const node = pathIndex.get(row.pagePath)
    if (!node) {
      warnings.push(
        `Keyword mapping referenced unknown sitemap path "${row.pagePath}" — row dropped.`,
      )
      continue
    }
    if (!keywordSet.has(row.primaryKeyword.toLowerCase())) {
      warnings.push(
        `Primary keyword "${row.primaryKeyword}" was not in the approved list — row dropped (page "${row.pagePath}").`,
      )
      continue
    }
    const primaryKey = row.primaryKeyword.toLowerCase()
    if (usedPrimaries.has(primaryKey)) {
      warnings.push(
        `Primary keyword "${row.primaryKeyword}" was assigned to multiple pages — only the first kept.`,
      )
      continue
    }
    if (claimedPagePaths.has(row.pagePath)) {
      warnings.push(
        `Page "${row.pagePath}" was assigned multiple primary keywords — only the first kept.`,
      )
      continue
    }
    const filteredSecondaries = row.secondaryKeywords.filter((k) =>
      keywordSet.has(k.toLowerCase()),
    )
    const droppedSecondaries =
      row.secondaryKeywords.length - filteredSecondaries.length
    if (droppedSecondaries > 0) {
      warnings.push(
        `Dropped ${droppedSecondaries} off-list secondary keyword(s) on page "${row.pagePath}".`,
      )
    }
    usedPrimaries.add(primaryKey)
    claimedPagePaths.add(row.pagePath)
    keywordMapping.push({
      pageName: node.name,
      pagePath: node.path,
      newUrl: urlFor(node),
      primaryKeyword: row.primaryKeyword,
      secondaryKeywords: filteredSecondaries,
      rationale: row.rationale,
    })
  }

  const unusedKeywords = [...keywordSet].filter(
    (k) => !usedPrimaries.has(k),
  ).length
  if (unusedKeywords > 0) {
    warnings.push(
      `${unusedKeywords} approved keyword(s) were not assigned as a primary on any page.`,
    )
  }

  // Resolve & validate URL mapping.
  const urlMapping: UrlMapping[] = []
  const seenOldUrls = new Set<string>()
  for (const row of parsed.urlMapping) {
    if (!crawledSet.has(row.oldUrl)) {
      warnings.push(
        `URL mapping referenced un-crawled URL "${row.oldUrl}" — row dropped.`,
      )
      continue
    }
    if (seenOldUrls.has(row.oldUrl)) {
      warnings.push(`Duplicate URL mapping for "${row.oldUrl}" — only the first kept.`)
      continue
    }
    seenOldUrls.add(row.oldUrl)

    let newUrl: string | null = null
    let redirectType: RedirectType = row.redirectType
    if (row.targetPagePath) {
      const node = pathIndex.get(row.targetPagePath)
      if (!node) {
        warnings.push(
          `URL mapping target "${row.targetPagePath}" not found in sitemap — falling back to redirectType=none for "${row.oldUrl}".`,
        )
        redirectType = "none"
      } else {
        newUrl = urlFor(node)
        redirectType = "301"
      }
    } else {
      redirectType = "none"
    }
    urlMapping.push({
      oldUrl: row.oldUrl,
      newUrl,
      redirectType,
      notes: row.notes,
    })
  }

  // Add a stub row for any crawled URL Claude forgot — better to surface as
  // "needs review" than silently drop it.
  const unhandled = crawledUrls.filter((url) => !seenOldUrls.has(url))
  for (const url of unhandled) {
    urlMapping.push({
      oldUrl: url,
      newUrl: null,
      redirectType: "none",
      notes: "Not addressed by Claude — needs manual review.",
    })
  }
  if (unhandled.length > 0) {
    warnings.push(
      `Claude did not address ${unhandled.length} crawled URL(s); they are listed with redirectType=none for manual review.`,
    )
  }

  // Resolve & validate internal linking.
  const internalLinking: InternalLink[] = []
  const seenLinkPairs = new Set<string>()
  for (const row of parsed.internalLinking) {
    if (row.sourcePagePath === row.targetPagePath) {
      warnings.push(
        `Internal link from "${row.sourcePagePath}" to itself — dropped.`,
      )
      continue
    }
    const sourceNode = pathIndex.get(row.sourcePagePath)
    const targetNode = pathIndex.get(row.targetPagePath)
    if (!sourceNode || !targetNode) {
      warnings.push(
        `Internal link referenced unknown path(s): "${row.sourcePagePath}" → "${row.targetPagePath}" — dropped.`,
      )
      continue
    }
    const pairKey = `${row.sourcePagePath} ${row.targetPagePath}`
    if (seenLinkPairs.has(pairKey)) {
      warnings.push(
        `Duplicate internal link pair "${row.sourcePagePath}" → "${row.targetPagePath}" — only the first kept.`,
      )
      continue
    }
    seenLinkPairs.add(pairKey)
    internalLinking.push({
      sourcePage: sourceNode.name,
      sourcePath: sourceNode.path,
      sourceUrl: urlFor(sourceNode),
      targetPage: targetNode.name,
      targetPath: targetNode.path,
      targetUrl: urlFor(targetNode),
      anchorText: row.anchorText,
      rationale: row.rationale,
    })
  }

  const durationSeconds = (Date.now() - startedAt) / 1000
  const inputTokens = claudeResult.usage.input_tokens
  const outputTokens = claudeResult.usage.output_tokens
  // Opus 4.7 pricing (mirrors lib/claude.ts constants).
  const costUsd =
    (inputTokens / 1_000_000) * 15 + (outputTokens / 1_000_000) * 75

  const output: InitialStrategyOutput = {
    partnerId: partner.id,
    partnerName: partner.name,
    generatedAt: new Date().toISOString(),
    keywordMapping,
    urlMapping,
    internalLinking,
    sitemapPageCount: pathIndex.size,
    crawledUrlCount: crawledUrls.length,
    costUsd,
    durationSeconds,
    warnings,
  }
  return { output, warnings }
}
