import "server-only"
import * as cheerio from "cheerio"
import { callClaude } from "@/lib/claude"
import {
  fetchRawHtml,
  instantPageProbe,
  OnPageError,
  runOnPageCrawl,
} from "@/lib/dataforseo-onpage"

/**
 * Alt Tag Generation tool.
 *
 * Pipeline:
 *   1. Run a DataForSEO On-Page crawl with `store_raw_html: true`.
 *   2. For each crawled OK page, fetch the stored raw HTML and pull out
 *      every `<img>` element along with light page context (title, h1,
 *      surrounding text snippet, current alt, nearby figcaption).
 *   3. Send one Claude request per page that lists every image on that
 *      page along with the page context. Claude returns suggested alt
 *      text per image, scoped by SEO best practice (descriptive, ≤125
 *      chars, no "image of …" stuffing).
 *   4. Caller turns the resulting rows into a CSV.
 *
 * Reuses the same On-Page client used by the Audit tab so JS rendering
 * is auto-detected via the same `instant_pages` probe.
 */

const FETCH_HTML_CONCURRENCY = 6
const ALT_GEN_CONCURRENCY = 4
/** Hard ceiling on text excerpt sent to Claude per page. */
const PAGE_TEXT_EXCERPT_CHARS = 2000
/** Hard ceiling on context text per individual image. */
const IMAGE_NEARBY_TEXT_CHARS = 240
/** Don't bother sending tracking pixels / spacers to Claude. */
const IMG_SRC_BLOCK_PATTERNS: RegExp[] = [
  /\.svg(?:\?|$)/i,
  /^data:/i,
  /^javascript:/i,
  /\/spacer\.(gif|png)/i,
  /\/blank\.(gif|png)/i,
  /1x1\.(gif|png)/i,
  /pixel\.(gif|png)/i,
]

const ALT_TEXT_MAX_CHARS = 125

export interface AltTagRow {
  pageUrl: string
  imageUrl: string
  currentAlt: string
  generatedAlt: string
  /** True if the image already had alt text and we left the suggestion as-is on user request. */
  skipped: boolean
}

export interface AltTagsResult {
  rows: AltTagRow[]
  pagesCrawled: number
  pagesWithImages: number
  imagesFound: number
  imagesProcessed: number
  durationMs: number
}

export interface GenerateAltTagsOptions {
  domain: string
  /** Cap pages crawled. Default 200, max 1000. */
  maxPages?: number
  /** When true, only generate alt for images missing/empty alt attr. Default true. */
  skipImagesWithAlt?: boolean
}

interface PageImageRow {
  /** Resolved absolute URL of the <img>. */
  src: string
  /** Original alt attr (trimmed, may be empty string). */
  currentAlt: string
  /** Free-text snippet near the image (figcaption + parent text). */
  nearbyText: string
}

interface PageContext {
  pageUrl: string
  title: string
  h1: string
  textExcerpt: string
  images: PageImageRow[]
}

function normalizeDomain(domain: string): string {
  return domain
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase()
}

function isUsableImageSrc(src: string): boolean {
  if (!src) return false
  const trimmed = src.trim()
  if (trimmed.length === 0) return false
  for (const re of IMG_SRC_BLOCK_PATTERNS) {
    if (re.test(trimmed)) return false
  }
  return true
}

/**
 * Pick the first usable URL out of a srcset attribute. srcset entries are
 * comma-separated `url descriptor`. We only need the URL — the largest
 * variant is fine but parsing density/width adds no value when we just
 * want a stable reference for the CSV.
 */
function firstSrcsetUrl(srcset: string): string | null {
  for (const part of srcset.split(",")) {
    const url = part.trim().split(/\s+/)[0]
    if (url) return url
  }
  return null
}

function resolveUrl(base: string, href: string): string | null {
  try {
    return new URL(href, base).toString()
  } catch {
    return null
  }
}

function trimWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

/**
 * Pull every <img> on the page along with light context for alt-text
 * generation. Resolves relative srcs to absolute against `pageUrl` and
 * de-duplicates by absolute src (an image referenced multiple times on
 * one page only needs one alt suggestion).
 */
export function extractPageContext(
  pageUrl: string,
  html: string,
): PageContext {
  const $ = cheerio.load(html)

  const title = trimWhitespace($("head > title").first().text() ?? "")
  const h1 = trimWhitespace($("h1").first().text() ?? "")

  // Strip non-content sections so the excerpt represents body copy, not
  // nav/footer chrome.
  $("script, style, noscript, nav, header, footer, svg").remove()
  const bodyText = trimWhitespace($("body").text() ?? "").slice(
    0,
    PAGE_TEXT_EXCERPT_CHARS,
  )

  const seen = new Set<string>()
  const images: PageImageRow[] = []
  $("img").each((_, el) => {
    const $img = $(el)
    const rawSrc =
      $img.attr("src") ??
      $img.attr("data-src") ??
      $img.attr("data-lazy-src") ??
      $img.attr("data-original") ??
      ""
    let candidate = rawSrc
    if (!isUsableImageSrc(candidate)) {
      const srcset = $img.attr("srcset") ?? $img.attr("data-srcset") ?? ""
      const fromSet = firstSrcsetUrl(srcset)
      if (fromSet) candidate = fromSet
    }
    if (!isUsableImageSrc(candidate)) return

    const absolute = resolveUrl(pageUrl, candidate)
    if (!absolute) return
    if (seen.has(absolute)) return
    seen.add(absolute)

    const currentAlt = trimWhitespace($img.attr("alt") ?? "")

    // Nearby text helps Claude write descriptive alt text. Prefer
    // figcaption when present (often the editor wrote a literal caption
    // that we can use as a starting point), then parent paragraph or
    // section heading.
    const $figure = $img.closest("figure")
    let nearbyText = ""
    if ($figure.length > 0) {
      nearbyText = trimWhitespace($figure.find("figcaption").first().text())
    }
    if (!nearbyText) {
      const $parent = $img.parent()
      nearbyText = trimWhitespace($parent.text())
    }
    nearbyText = nearbyText.slice(0, IMAGE_NEARBY_TEXT_CHARS)

    images.push({
      src: absolute,
      currentAlt,
      nearbyText,
    })
  })

  return {
    pageUrl,
    title,
    h1,
    textExcerpt: bodyText,
    images,
  }
}

interface ClaudeAltSuggestion {
  src: string
  alt: string
}

function buildPrompt(ctx: PageContext, imagesToSend: PageImageRow[]): string {
  const imageBlocks = imagesToSend
    .map((img, i) => {
      const lines = [
        `Image #${i + 1}`,
        `src: ${img.src}`,
      ]
      if (img.currentAlt) lines.push(`current_alt: ${img.currentAlt}`)
      if (img.nearbyText) lines.push(`nearby_text: ${img.nearbyText}`)
      return lines.join("\n")
    })
    .join("\n\n")

  return `You are an SEO copywriter generating descriptive alt text for images on a website page. Produce concise, accurate, keyword-relevant alt text that describes what each image actually shows in the context of the page content.

RULES
- Each alt text must be ≤ ${ALT_TEXT_MAX_CHARS} characters.
- Do NOT start with "Image of", "Picture of", "Photo of" — describe the subject directly.
- Do NOT keyword-stuff. One natural mention of a relevant keyword is fine.
- If the image is decorative (logo, icon, divider) and the surrounding content makes that clear, still produce a short descriptive alt — do not return an empty string.
- Use the page title, H1, and nearby text to make the alt specific to this page (e.g. include the service name or location when contextually appropriate).
- Output strictly valid JSON. No prose before or after.

PAGE CONTEXT
url: ${ctx.pageUrl}
title: ${ctx.title || "(none)"}
h1: ${ctx.h1 || "(none)"}
body_excerpt: ${ctx.textExcerpt || "(none)"}

IMAGES
${imageBlocks}

OUTPUT FORMAT
Return a JSON array. One object per image, in the same order as listed above:
[
  { "src": "<exact src from input>", "alt": "<suggested alt text>" }
]`
}

/**
 * Strip leading/trailing markdown fences so JSON.parse can handle Claude
 * output even when the model wraps it in ```json fences despite the
 * instruction.
 */
function stripJsonFences(text: string): string {
  const trimmed = text.trim()
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fenceMatch) return fenceMatch[1].trim()
  return trimmed
}

function parseClaudeSuggestions(text: string): ClaudeAltSuggestion[] {
  const stripped = stripJsonFences(text)
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: ClaudeAltSuggestion[] = []
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue
    const obj = item as Record<string, unknown>
    const src = obj.src
    const alt = obj.alt
    if (typeof src !== "string" || typeof alt !== "string") continue
    out.push({ src, alt: alt.trim().slice(0, ALT_TEXT_MAX_CHARS) })
  }
  return out
}

async function generateAltsForPage(
  ctx: PageContext,
  imagesToSend: PageImageRow[],
): Promise<Map<string, string>> {
  if (imagesToSend.length === 0) return new Map()
  const prompt = buildPrompt(ctx, imagesToSend)
  const text = await callClaude(prompt, {
    model: "claude-sonnet-4-6",
    maxTokens: Math.min(8192, 256 + imagesToSend.length * 80),
  })
  const suggestions = parseClaudeSuggestions(text)
  const map = new Map<string, string>()
  for (const s of suggestions) map.set(s.src, s.alt)
  return map
}

async function withConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const runners = new Array(Math.min(limit, items.length))
    .fill(0)
    .map(async () => {
      for (;;) {
        const idx = cursor++
        if (idx >= items.length) return
        results[idx] = await worker(items[idx], idx)
      }
    })
  await Promise.all(runners)
  return results
}

export async function generateAltTags(
  options: GenerateAltTagsOptions,
): Promise<AltTagsResult> {
  const startedAt = Date.now()
  const domain = normalizeDomain(options.domain)
  const origin = `https://${domain}`
  const skipImagesWithAlt = options.skipImagesWithAlt !== false
  const maxPages = Math.min(Math.max(options.maxPages ?? 200, 1), 1000)

  // Decide JS rendering up front via the same probe the Audit tab uses.
  const probe = await instantPageProbe(`${origin}/`, false).catch(() => null)
  const enableJavaScript = !!(
    probe &&
    (!probe.hasTitle || !probe.hasDescription)
  )

  let crawl: Awaited<ReturnType<typeof runOnPageCrawl>>
  try {
    crawl = await runOnPageCrawl({
      domain,
      maxPages,
      enableJavaScript,
    })
  } catch (err) {
    if (err instanceof OnPageError) {
      throw new Error(`On-Page crawl failed: ${err.message}`)
    }
    throw err
  }

  const okPages = crawl.pages.filter(
    (p) => p.statusCode >= 200 && p.statusCode < 300,
  )

  // Fetch raw HTML for every OK page in parallel (capped concurrency).
  const htmlByUrl = new Map<string, string>()
  await withConcurrency(okPages, FETCH_HTML_CONCURRENCY, async (page) => {
    const url = page.finalUrl || page.url
    try {
      const html = await fetchRawHtml(crawl.taskId, url)
      if (html) htmlByUrl.set(url, html)
    } catch (err) {
      console.warn(
        `[alt-tags] raw_html failed for ${url}: ${err instanceof Error ? err.message : "unknown"}`,
      )
    }
  })

  // Build per-page context. Pages with zero usable images don't need a
  // Claude call; we still count them toward `pagesCrawled`.
  const contexts: PageContext[] = []
  let imagesFound = 0
  for (const [url, html] of htmlByUrl) {
    const ctx = extractPageContext(url, html)
    imagesFound += ctx.images.length
    if (ctx.images.length > 0) contexts.push(ctx)
  }

  // For each page, decide which images we actually want Claude to label.
  // When `skipImagesWithAlt` is true, images whose current alt is non-empty
  // pass through to the CSV with `skipped: true` and an empty
  // `generatedAlt` — caller can still surface them so the user sees the
  // existing alt.
  const rows: AltTagRow[] = []
  let pagesWithImages = 0
  let imagesProcessed = 0

  await withConcurrency(contexts, ALT_GEN_CONCURRENCY, async (ctx) => {
    pagesWithImages += 1
    const needAlt = ctx.images.filter(
      (img) => !skipImagesWithAlt || img.currentAlt.length === 0,
    )
    let suggestions: Map<string, string>
    try {
      suggestions = await generateAltsForPage(ctx, needAlt)
    } catch (err) {
      console.warn(
        `[alt-tags] alt-gen failed for ${ctx.pageUrl}: ${err instanceof Error ? err.message : "unknown"}`,
      )
      suggestions = new Map()
    }
    for (const img of ctx.images) {
      const generated = suggestions.get(img.src) ?? ""
      const skipped =
        skipImagesWithAlt && img.currentAlt.length > 0
      if (!skipped) imagesProcessed += 1
      rows.push({
        pageUrl: ctx.pageUrl,
        imageUrl: img.src,
        currentAlt: img.currentAlt,
        generatedAlt: skipped ? "" : generated,
        skipped,
      })
    }
  })

  // Stable sort: by page URL, then image URL.
  rows.sort((a, b) => {
    if (a.pageUrl !== b.pageUrl) return a.pageUrl.localeCompare(b.pageUrl)
    return a.imageUrl.localeCompare(b.imageUrl)
  })

  return {
    rows,
    pagesCrawled: okPages.length,
    pagesWithImages,
    imagesFound,
    imagesProcessed,
    durationMs: Date.now() - startedAt,
  }
}

function csvEscape(value: unknown): string {
  if (value == null) return ""
  const s = String(value)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

export function rowsToCsv(rows: AltTagRow[]): string {
  const header = ["page_url", "image_url", "current_alt", "suggested_alt"]
  const lines = [header.join(",")]
  for (const r of rows) {
    lines.push(
      [r.pageUrl, r.imageUrl, r.currentAlt, r.generatedAlt]
        .map(csvEscape)
        .join(","),
    )
  }
  return lines.join("\n")
}
