import "server-only"
import { z } from "zod"
import { recordDataForSEOCost } from "@/lib/audit-cost"
import { requireEnv } from "@/lib/env"

// CAUTION: response shapes are best-effort from documentation. The first
// real run will surface mismatches — when that happens, log the failing
// envelope and adjust the schemas. Don't tighten validation aggressively
// until the response shape is confirmed against real responses.

const DFS_BASE = "https://api.dataforseo.com"
const RATE_LIMIT_RETRY_MS = 2_000

const POLL_INITIAL_WAIT_MS = 30_000
const POLL_INTERVAL_MS = 10_000
/**
 * Hard ceiling on poll wait. Vercel Pro / Fluid Compute caps function
 * runtime at 800s. We give the crawl up to 9 minutes, which leaves
 * breathing room for the adapter, link-graph fetch, schema sampling
 * (~16 raw_html calls), and the Claude synthesis to all run after the
 * crawl. If polling exceeds this we fall through and try to fetch
 * whatever pages are already in the result set — partial data is more
 * useful than failing the audit, and DFS often hasn't flipped to
 * "finished" status even when the queue is fully drained.
 */
const POLL_TIMEOUT_MS = 540_000
/**
 * Stable-progress short-circuit. If `pages_crawled` doesn't move across
 * this many consecutive polls, treat the crawl as effectively done even
 * when the status field is still "in_progress" — DFS sometimes lags the
 * status update behind the actual crawl completion.
 */
const STABLE_PROGRESS_POLLS = 3
const POLL_TIMEOUT_MS_LABEL = `${POLL_TIMEOUT_MS / 1000}s`

const PAGES_FETCH_LIMIT = 1_000

export class OnPageError extends Error {
  readonly status: number | undefined
  readonly dfsStatus: number | undefined
  constructor(
    message: string,
    opts: { status?: number; dfsStatus?: number } = {},
  ) {
    super(message)
    this.name = "OnPageError"
    this.status = opts.status
    this.dfsStatus = opts.dfsStatus
  }
}

// ── Envelope ────────────────────────────────────────────────────────────────

const onPageTaskSchema = z
  .object({
    id: z.string().optional(),
    status_code: z.number(),
    status_message: z.string(),
    cost: z.number().optional(),
    result_count: z.number().optional(),
    result: z.array(z.unknown()).nullable().optional(),
  })
  .passthrough()

const onPageEnvelopeSchema = z
  .object({
    status_code: z.number(),
    status_message: z.string(),
    cost: z.number().optional(),
    tasks: z.array(onPageTaskSchema).optional().default([]),
  })
  .passthrough()

type OnPageEnvelope = z.infer<typeof onPageEnvelopeSchema>

function authHeader(): string {
  const login = requireEnv("DATAFORSEO_LOGIN")
  const password = requireEnv("DATAFORSEO_PASSWORD")
  const token = Buffer.from(`${login}:${password}`).toString("base64")
  return `Basic ${token}`
}

async function dfsOnPageRequest(
  endpoint: string,
  body: unknown,
): Promise<OnPageEnvelope> {
  const url = `${DFS_BASE}${endpoint}`
  const init: RequestInit = {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }

  // Mirror the pattern from lib/dataforseo.ts: retry up to 3 times on 429
  // with exponential backoff + jitter so a burst of parallel calls doesn't
  // bunch up at the same retry instant.
  let response = await fetch(url, init)
  for (let attempt = 0; attempt < 3 && response.status === 429; attempt++) {
    const backoffMs =
      RATE_LIMIT_RETRY_MS * 2 ** attempt + Math.floor(Math.random() * 500)
    await new Promise((r) => setTimeout(r, backoffMs))
    response = await fetch(url, init)
  }

  if (!response.ok) {
    const text = await response.text()
    throw new OnPageError(
      `DataForSEO On-Page HTTP ${response.status}: ${text.slice(0, 500)}`,
      { status: response.status },
    )
  }

  const json: unknown = await response.json()
  const parsed = onPageEnvelopeSchema.safeParse(json)
  if (!parsed.success) {
    throw new OnPageError(
      `DataForSEO On-Page response did not match expected shape: ${parsed.error.message}`,
    )
  }
  const envelope = parsed.data

  const envelopeCost = envelope.cost ?? 0
  recordDataForSEOCost(envelopeCost)
  console.log(
    `[dataforseo-onpage] endpoint=${endpoint} dfs_status=${envelope.status_code} cost=$${envelopeCost.toFixed(4)} tasks=${envelope.tasks.length}`,
  )

  if (envelope.status_code !== 20000) {
    throw new OnPageError(
      `DataForSEO On-Page returned status ${envelope.status_code}: ${envelope.status_message}`,
      { dfsStatus: envelope.status_code },
    )
  }

  // Per-task success check. Task-level failures should throw so callers
  // surface the underlying error instead of silently producing an empty
  // crawl report.
  //
  // DFS status codes for async On-Page tasks:
  //   20000  Ok (task complete, results ready)
  //   20100  Task Created (just submitted, not yet picked up)
  //   40601  Task Not Ready (response not yet available)
  //   40602  Task In Queue (queued, hasn't started)
  //   40603  Task Handed (handed to a worker, processing)
  // The 4060x codes are transient "poll again" states, not errors —
  // letting them through means the polling loop in runOnPageCrawl gets
  // the envelope, sees no usable result yet, and retries on its
  // schedule. Anything else (40500-range failures, 40400 Not Found,
  // 5xxxx server errors) is a real failure and throws.
  const TRANSIENT_TASK_CODES = new Set([20000, 20100, 40601, 40602, 40603])
  for (const task of envelope.tasks) {
    if (!TRANSIENT_TASK_CODES.has(task.status_code)) {
      throw new OnPageError(
        `DataForSEO On-Page task failed with status ${task.status_code}: ${task.status_message} (endpoint=${endpoint})`,
        { dfsStatus: task.status_code },
      )
    }
  }

  return envelope
}

// ── Item shapes ─────────────────────────────────────────────────────────────
//
// Loose validation by design — On-Page payloads contain dozens of fields
// per page and the documented shape changes over time. Pull the handful of
// fields we care about with optional() / nullable() everywhere, and let the
// rest pass through. If a real response surfaces a missing required field,
// log + relax the schema rather than tightening it.

const htagsSchema = z
  .object({
    h1: z.array(z.string()).optional(),
    h2: z.array(z.string()).optional(),
    h3: z.array(z.string()).optional(),
  })
  .passthrough()

const metaContentSchema = z
  .object({
    plain_text_word_count: z.number().nullable().optional(),
    plain_text_size: z.number().nullable().optional(),
  })
  .passthrough()

const metaSchema = z
  .object({
    title: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    canonical: z.string().nullable().optional(),
    htags: htagsSchema.nullable().optional(),
    images_count: z.number().nullable().optional(),
    images_alt_count: z.number().nullable().optional(),
    internal_links_count: z.number().nullable().optional(),
    external_links_count: z.number().nullable().optional(),
    scripts_count: z.number().nullable().optional(),
    content: metaContentSchema.nullable().optional(),
  })
  .passthrough()

const pageItemSchema = z
  .object({
    url: z.string().optional(),
    page_url: z.string().optional(),
    final_url: z.string().nullable().optional(),
    status_code: z.number().nullable().optional(),
    meta: metaSchema.nullable().optional(),
    redirect: z
      .object({
        url: z.string().optional(),
        type: z.string().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    redirect_chain: z.array(z.unknown()).nullable().optional(),
    is_redirect: z.boolean().nullable().optional(),
    fetch_time: z.string().nullable().optional(),
    cache_control: z
      .object({
        cachable: z.boolean().optional(),
        ttl: z.number().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    page_timing: z
      .object({
        time_to_interactive: z.number().nullable().optional(),
        dom_complete: z.number().nullable().optional(),
        duration_time: z.number().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    total_dom_size: z.number().nullable().optional(),
    custom_js_response: z.unknown().optional(),
    onpage_score: z.number().nullable().optional(),
  })
  .passthrough()

const summaryResultSchema = z
  .object({
    crawl_progress: z.string().optional(),
    crawl_status: z
      .object({
        max_crawl_pages: z.number().optional(),
        pages_in_queue: z.number().optional(),
        pages_crawled: z.number().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    domain_info: z
      .object({
        name: z.string().optional(),
        cms: z.string().nullable().optional(),
        ip: z.string().nullable().optional(),
        server: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    page_metrics: z.unknown().optional(),
  })
  .passthrough()

const linkItemSchema = z
  .object({
    type: z.string().optional(),
    direction: z.string().optional(),
    page_from: z.string().optional(),
    link_from: z.string().optional(),
    domain_from: z.string().optional(),
    page_to: z.string().optional(),
    link_to: z.string().optional(),
    domain_to: z.string().optional(),
    is_broken: z.boolean().optional(),
    link_attribute: z.string().optional(),
  })
  .passthrough()

const rawHtmlResultSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            url: z.string().optional(),
            html: z.string().nullable().optional(),
            status_code: z.number().nullable().optional(),
          })
          .passthrough(),
      )
      .nullable()
      .optional(),
    items_count: z.number().optional(),
  })
  .passthrough()

// ── Public types ────────────────────────────────────────────────────────────

export interface InstantProbeResult {
  url: string
  hasTitle: boolean
  hasDescription: boolean
  status: number
}

export interface OnPagePageRow {
  url: string
  finalUrl: string
  statusCode: number
  title: string | null
  description: string | null
  canonical: string | null
  metaRobots: string | null
  h1s: string[]
  h2s: string[]
  h3s: string[]
  wordCount: number
  imagesTotal: number
  imagesWithAlt: number
  internalLinksCount: number
  redirectChain: string[]
  loadTimeMs: number
}

export interface OnPageCrawlResult {
  taskId: string
  pages: OnPagePageRow[]
  enabledJavaScript: boolean
  durationMs: number
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function firstString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.trim().length > 0) return v
  }
  return null
}

function firstNumber(...values: unknown[]): number | null {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) return v
  }
  return null
}

function normalizeRedirectChain(
  raw: unknown,
  fallbackUrl: string,
): string[] {
  if (!Array.isArray(raw)) return [fallbackUrl]
  const chain: string[] = []
  for (const entry of raw) {
    if (typeof entry === "string") {
      chain.push(entry)
      continue
    }
    if (entry && typeof entry === "object") {
      const obj = entry as Record<string, unknown>
      const url = firstString(obj.url, obj.from_url, obj.to_url, obj.target)
      if (url) chain.push(url)
    }
  }
  if (chain.length === 0) return [fallbackUrl]
  return chain
}

function parsePageItem(raw: unknown): OnPagePageRow | null {
  const parsed = pageItemSchema.safeParse(raw)
  if (!parsed.success) {
    console.warn(
      "[dataforseo-onpage] pageItemSchema mismatch — dropping row:",
      parsed.error.message.slice(0, 200),
    )
    return null
  }
  const item = parsed.data
  const startUrl = firstString(item.url, item.page_url) ?? ""
  if (!startUrl) return null
  const finalUrl = firstString(item.final_url) ?? startUrl

  const meta = item.meta ?? null
  const htags = meta?.htags ?? null
  const wordCount =
    firstNumber(meta?.content?.plain_text_word_count) ?? 0
  const imagesTotal = firstNumber(meta?.images_count) ?? 0
  const imagesWithAlt = firstNumber(meta?.images_alt_count) ?? 0
  const internalLinksCount = firstNumber(meta?.internal_links_count) ?? 0

  const redirectChainRaw = item.redirect_chain
  const redirectChain = normalizeRedirectChain(redirectChainRaw, startUrl)
  if (item.redirect && typeof item.redirect === "object") {
    const redirectUrl = firstString(
      (item.redirect as Record<string, unknown>).url,
    )
    if (redirectUrl && !redirectChain.includes(redirectUrl)) {
      redirectChain.push(redirectUrl)
    }
  }
  if (finalUrl && !redirectChain.includes(finalUrl)) {
    redirectChain.push(finalUrl)
  }

  const loadTimeMs =
    firstNumber(
      item.page_timing?.duration_time,
      item.page_timing?.time_to_interactive,
      item.page_timing?.dom_complete,
    ) ?? 0

  return {
    url: startUrl,
    finalUrl,
    statusCode: firstNumber(item.status_code) ?? 0,
    title: firstString(meta?.title),
    description: firstString(meta?.description),
    canonical: firstString(meta?.canonical),
    // On-Page does not expose meta robots directly in the page row schema
    // we observe in docs. Leave null and let the synthesis treat it as
    // unknown rather than fabricate a value.
    metaRobots: null,
    h1s: Array.isArray(htags?.h1) ? htags.h1.filter((s) => typeof s === "string") : [],
    h2s: Array.isArray(htags?.h2) ? htags.h2.filter((s) => typeof s === "string") : [],
    h3s: Array.isArray(htags?.h3) ? htags.h3.filter((s) => typeof s === "string") : [],
    wordCount,
    imagesTotal,
    imagesWithAlt,
    internalLinksCount,
    redirectChain,
    loadTimeMs,
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * One-shot synchronous probe of a single URL — used to decide whether the
 * site needs JS rendering before we kick off the multi-page crawl. The
 * heuristic is: if a JS-disabled fetch returns a head with a title AND
 * description, static HTML is sufficient and we save the JS-rendering
 * surcharge. Otherwise we re-run the full crawl with JS enabled.
 */
export async function instantPageProbe(
  url: string,
  enableJavaScript = false,
): Promise<InstantProbeResult> {
  const envelope = await dfsOnPageRequest("/v3/on_page/instant_pages", [
    {
      url,
      enable_javascript: enableJavaScript,
      load_resources: false,
      enable_browser_rendering: enableJavaScript,
    },
  ])

  const task = envelope.tasks[0]
  const result = task?.result?.[0] as Record<string, unknown> | undefined
  const items = result?.items
  const firstItem =
    Array.isArray(items) && items.length > 0
      ? (items[0] as Record<string, unknown>)
      : undefined

  if (!firstItem) {
    return { url, hasTitle: false, hasDescription: false, status: 0 }
  }

  const meta = firstItem.meta as Record<string, unknown> | undefined
  const title = firstString(meta?.title)
  const description = firstString(meta?.description)
  const status =
    firstNumber(firstItem.status_code) ?? 0

  return {
    url,
    hasTitle: !!title,
    hasDescription: !!description,
    status,
  }
}

/**
 * Submit a multi-page crawl and poll until it finishes. Throws
 * `OnPageError` if the poll times out or DataForSEO reports task failure.
 */
export async function runOnPageCrawl(opts: {
  domain: string
  maxPages: number
  enableJavaScript: boolean
}): Promise<OnPageCrawlResult> {
  const startedAt = Date.now()

  const taskBody: Record<string, unknown> = {
    target: opts.domain,
    max_crawl_pages: opts.maxPages,
    enable_javascript: opts.enableJavaScript,
    enable_browser_rendering: opts.enableJavaScript,
    load_resources: false,
    store_raw_html: true,
    respect_sitemap: true,
  }

  const postEnvelope = await dfsOnPageRequest("/v3/on_page/task_post", [
    taskBody,
  ])
  const task = postEnvelope.tasks[0]
  const taskId = task?.id
  if (!taskId) {
    throw new OnPageError(
      "DataForSEO On-Page task_post returned no task id",
    )
  }
  console.log(
    `[dataforseo-onpage] task_post submitted task=${taskId} target=${opts.domain} max=${opts.maxPages} js=${opts.enableJavaScript}`,
  )

  // Initial wait — small crawls are usually finished by the time we
  // first poll, large ones aren't anywhere near done. 30s is a
  // reasonable middle ground; longer polls happen at 10s cadence.
  await sleep(POLL_INITIAL_WAIT_MS)

  const pollDeadline = Date.now() + POLL_TIMEOUT_MS
  let lastCrawled: number | undefined = undefined
  let stableCount = 0
  let progressFinished = false
  let timedOut = false
  while (Date.now() < pollDeadline) {
    const summaryEnv = await dfsOnPageRequest("/v3/on_page/summary", [
      { id: taskId },
    ])
    const sumResult = summaryEnv.tasks[0]?.result?.[0]
    const sum = summaryResultSchema.safeParse(sumResult)
    if (!sum.success) {
      console.warn(
        "[dataforseo-onpage] summary shape mismatch:",
        sum.error.message.slice(0, 200),
      )
    } else {
      const progress = sum.data.crawl_progress
      const status = sum.data.crawl_status
      const crawled = status?.pages_crawled
      console.log(
        `[dataforseo-onpage] poll task=${taskId} progress=${progress} crawled=${crawled ?? "?"} queue=${status?.pages_in_queue ?? "?"}`,
      )
      if (progress === "finished") {
        progressFinished = true
        break
      }
      // Stable-progress short-circuit: when DFS is slow to flip
      // crawl_progress to "finished" but pages_crawled has stopped
      // moving, treat the crawl as done.
      if (typeof crawled === "number") {
        if (crawled === lastCrawled && crawled > 0) {
          stableCount += 1
          if (stableCount >= STABLE_PROGRESS_POLLS) {
            console.log(
              `[dataforseo-onpage] task=${taskId} stable at ${crawled} pages for ${stableCount} polls — proceeding`,
            )
            break
          }
        } else {
          stableCount = 0
          lastCrawled = crawled
        }
      }
    }
    await sleep(POLL_INTERVAL_MS)
  }

  if (!progressFinished && Date.now() >= pollDeadline) {
    timedOut = true
    console.warn(
      `[dataforseo-onpage] poll exceeded ${POLL_TIMEOUT_MS_LABEL} for task ${taskId} — fetching whatever pages are ready`,
    )
  }

  // Page through /pages until we run out of items. On timeout this
  // returns whatever DFS has crawled so far; if that's zero, we throw
  // below with the timeout error so the audit fails loudly rather than
  // silently producing an empty crawl.
  const pages: OnPagePageRow[] = []
  let offset = 0
  for (let i = 0; i < 50; i++) {
    const env = await dfsOnPageRequest("/v3/on_page/pages", [
      { id: taskId, limit: PAGES_FETCH_LIMIT, offset },
    ])
    const result = env.tasks[0]?.result?.[0] as
      | Record<string, unknown>
      | undefined
    const items = Array.isArray(result?.items) ? result.items : []
    if (items.length === 0) break
    for (const raw of items) {
      const row = parsePageItem(raw)
      if (row) pages.push(row)
    }
    if (items.length < PAGES_FETCH_LIMIT) break
    offset += items.length
  }

  if (timedOut && pages.length === 0) {
    throw new OnPageError(
      `DataForSEO On-Page poll timed out after ${POLL_TIMEOUT_MS_LABEL} for task ${taskId} and no pages were ready. Re-run; if this repeats, the site is too large for the current poll budget.`,
    )
  }

  const durationMs = Date.now() - startedAt
  console.log(
    `[dataforseo-onpage] task=${taskId} pages=${pages.length} duration=${durationMs}ms${timedOut ? " (partial — poll timed out)" : ""}`,
  )

  return {
    taskId,
    pages,
    enabledJavaScript: opts.enableJavaScript,
    durationMs,
  }
}

/**
 * Build the full internal-link graph for a finished On-Page task.
 * Pages through `/v3/on_page/links` and stitches sourceUrl → [targetUrls]
 * for every link DataForSEO reports as `type === "internal"` (or the
 * legacy `direction === "internal"` shape, which some versions emit).
 *
 * Returned map is keyed by the source page's final URL — same format the
 * legacy crawler used in `CrawledPage.internalLinksOut`.
 */
export async function fetchLinksGraph(
  taskId: string,
): Promise<Map<string, string[]>> {
  const out = new Map<string, Set<string>>()
  let offset = 0
  for (let i = 0; i < 50; i++) {
    const env = await dfsOnPageRequest("/v3/on_page/links", [
      { id: taskId, limit: PAGES_FETCH_LIMIT, offset },
    ])
    const result = env.tasks[0]?.result?.[0] as
      | Record<string, unknown>
      | undefined
    const items = Array.isArray(result?.items) ? result.items : []
    if (items.length === 0) break
    for (const raw of items) {
      const parsed = linkItemSchema.safeParse(raw)
      if (!parsed.success) continue
      const link = parsed.data
      const isInternal =
        link.type === "internal" || link.direction === "internal"
      if (!isInternal) continue
      const source = firstString(link.page_from, link.link_from)
      const target = firstString(link.page_to, link.link_to)
      if (!source || !target) continue
      const set = out.get(source) ?? new Set<string>()
      set.add(target)
      out.set(source, set)
    }
    if (items.length < PAGES_FETCH_LIMIT) break
    offset += items.length
  }
  const result = new Map<string, string[]>()
  for (const [source, targets] of out) {
    result.set(source, [...targets])
  }
  return result
}

/**
 * Fetch the raw HTML DataForSEO stored for a single crawled URL. Used by
 * the schema-extraction sample. Returns null when the page has no stored
 * HTML (e.g. non-HTML response, or `store_raw_html: false` on the task).
 */
export async function fetchRawHtml(
  taskId: string,
  url: string,
): Promise<string | null> {
  const env = await dfsOnPageRequest("/v3/on_page/raw_html", [
    { id: taskId, url },
  ])
  const result = env.tasks[0]?.result?.[0]
  const parsed = rawHtmlResultSchema.safeParse(result)
  if (!parsed.success) return null
  const items = parsed.data.items ?? []
  for (const item of items) {
    if (typeof item.html === "string" && item.html.length > 0) {
      return item.html
    }
  }
  return null
}
