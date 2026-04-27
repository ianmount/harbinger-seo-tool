import type {
  CannibalizationCluster,
  CannibalizationSignal,
  CrawledPage,
  GSCQueryRow,
  TargetMarket,
} from "@/lib/types"

/**
 * Detects pages on the prospect's site that are competing with each other for
 * the same keyword/location combination (a.k.a. keyword cannibalization). The
 * output feeds the audit synthesis prompt so Claude can recommend a winning
 * URL per cluster and flag the others for 301 redirect.
 *
 * Four signal types, run independently and then deduped by URL-set with this
 * priority order: identical_title > serp_overlap > title_similarity >
 * url_pattern. The strongest signal wins when the same cluster surfaces from
 * multiple detectors. We don't merge across signals because that risks lumping
 * unrelated pages into one over-broad cluster.
 *
 * Inputs are intentionally permissive: GSC and target markets are optional.
 * When they're absent the SERP-overlap and location-aware URL-pattern checks
 * silently degrade. The title/URL checks always run on the crawl alone.
 */

// ── Tunables ──────────────────────────────────────────────────────────────

/** Title token-set Jaccard threshold for the title_similarity signal. */
const TITLE_JACCARD_THRESHOLD = 0.8

/** Top-N positions both pages must rank within for a SERP overlap. */
const SERP_OVERLAP_TOP_N = 20

/** Max position delta between the two ranking pages for SERP overlap. */
const SERP_OVERLAP_POS_DELTA = 10

/**
 * Auto-detected brand suffix needs to appear after a separator on at least
 * this fraction of titles before we strip it. Below this we leave titles
 * alone — the suffix is more likely a section breadcrumb than a brand.
 */
const BRAND_SUFFIX_MIN_FRACTION = 0.3

/** English stopwords. Kept short and generic; no industry vocabulary. */
const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "of",
  "for",
  "to",
  "in",
  "on",
  "at",
  "by",
  "with",
  "from",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "your",
  "you",
  "our",
  "we",
  "us",
  "i",
  "my",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "as",
  "if",
  "than",
  "then",
  "so",
  "into",
  "about",
  "near",
  "me",
])

// ── Title normalization ───────────────────────────────────────────────────

const SEPARATOR_REGEX = /\s+[|·•\-–—]\s+/

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t))
}

/**
 * Pick the most frequent trailing separator-segment across the title set.
 * Returns the suffix only if it appears on at least BRAND_SUFFIX_MIN_FRACTION
 * of the titles — otherwise we leave titles alone.
 */
function inferBrandSuffix(titles: ReadonlyArray<string>): string | null {
  const counts = new Map<string, number>()
  let titlesWithSeparator = 0
  for (const t of titles) {
    const parts = t.split(SEPARATOR_REGEX)
    if (parts.length < 2) continue
    titlesWithSeparator += 1
    const last = parts[parts.length - 1].trim().toLowerCase()
    if (!last) continue
    counts.set(last, (counts.get(last) ?? 0) + 1)
  }
  if (titlesWithSeparator === 0) return null
  let best: { suffix: string; count: number } | null = null
  for (const [suffix, count] of counts) {
    if (!best || count > best.count) best = { suffix, count }
  }
  if (!best) return null
  if (best.count / titles.length < BRAND_SUFFIX_MIN_FRACTION) return null
  return best.suffix
}

function stripBrandSuffix(title: string, brand: string | null): string {
  if (!brand) return title
  const parts = title.split(SEPARATOR_REGEX)
  if (parts.length < 2) {
    // Strip the bare brand string when it appears anywhere.
    const re = new RegExp(`\\b${escapeRegExp(brand)}\\b`, "gi")
    return title.replace(re, " ").replace(/\s+/g, " ").trim()
  }
  const lastIdx = parts.length - 1
  if (parts[lastIdx].trim().toLowerCase() === brand.toLowerCase()) {
    return parts.slice(0, lastIdx).join(" ").trim()
  }
  return title
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

interface NormalizedPage {
  url: string
  rawTitle: string
  normalizedTitle: string
  tokenSet: Set<string>
  slugTokens: Set<string>
}

function normalizePage(
  page: CrawledPage,
  brand: string | null,
): NormalizedPage {
  const rawTitle = page.title ?? ""
  const stripped = stripBrandSuffix(rawTitle, brand)
  const tokens = tokenize(stripped)
  const normalizedTitle = tokens.join(" ")
  let slugTokens: Set<string>
  try {
    const u = new URL(page.finalUrl || page.url)
    slugTokens = new Set(
      u.pathname
        .toLowerCase()
        .split(/[\/\-_]+/)
        .filter((t) => t.length > 1 && !STOPWORDS.has(t)),
    )
  } catch {
    slugTokens = new Set()
  }
  return {
    url: page.finalUrl || page.url,
    rawTitle,
    normalizedTitle,
    tokenSet: new Set(tokens),
    slugTokens,
  }
}

// ── Detectors ─────────────────────────────────────────────────────────────

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let intersection = 0
  for (const v of a) if (b.has(v)) intersection += 1
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

function detectIdenticalTitle(
  pages: ReadonlyArray<NormalizedPage>,
): CannibalizationCluster[] {
  const buckets = new Map<string, NormalizedPage[]>()
  for (const p of pages) {
    if (!p.normalizedTitle) continue
    const list = buckets.get(p.normalizedTitle) ?? []
    list.push(p)
    buckets.set(p.normalizedTitle, list)
  }
  const out: CannibalizationCluster[] = []
  for (const [, group] of buckets) {
    if (group.length < 2) continue
    out.push({
      cluster: group.map((g) => g.url),
      sharedSignal: "identical_title",
      sharedTitle: group[0].normalizedTitle,
      recommendationHint: "consolidate_to_stronger",
    })
  }
  return out
}

function detectTitleSimilarity(
  pages: ReadonlyArray<NormalizedPage>,
): CannibalizationCluster[] {
  // Pairwise similarity; n is bounded by crawler page cap (~50–500).
  const out: CannibalizationCluster[] = []
  const visited = new Set<number>()
  for (let i = 0; i < pages.length; i++) {
    if (visited.has(i)) continue
    const cluster = [i]
    for (let j = i + 1; j < pages.length; j++) {
      if (visited.has(j)) continue
      if (pages[i].tokenSet.size < 2 || pages[j].tokenSet.size < 2) continue
      // Skip identical-normalized-title pairs — they're handled above.
      if (pages[i].normalizedTitle === pages[j].normalizedTitle) continue
      const sim = jaccard(pages[i].tokenSet, pages[j].tokenSet)
      if (sim >= TITLE_JACCARD_THRESHOLD) {
        cluster.push(j)
      }
    }
    if (cluster.length >= 2) {
      cluster.forEach((idx) => visited.add(idx))
      out.push({
        cluster: cluster.map((idx) => pages[idx].url),
        sharedSignal: "title_similarity",
        sharedTitle: pages[cluster[0]].rawTitle,
        recommendationHint: "differentiate_intent",
      })
    }
  }
  return out
}

function detectUrlPattern(
  pages: ReadonlyArray<NormalizedPage>,
  targetMarkets: ReadonlyArray<TargetMarket> | undefined,
): CannibalizationCluster[] {
  const cityTokens = new Set<string>()
  for (const m of targetMarkets ?? []) {
    for (const tok of tokenize(m.city)) cityTokens.add(tok)
  }
  const out: CannibalizationCluster[] = []
  // Bucket by (location_token, primary_noun) pair derived from slug tokens.
  // Primary noun = the most service-like non-location token; we don't know
  // what's a service vs. a generic word, so we use any non-stopword non-city
  // token of length >= 4 ("about", "blog" etc. are stopwords or too short).
  const buckets = new Map<string, NormalizedPage[]>()
  for (const p of pages) {
    if (p.slugTokens.size === 0) continue
    const cities: string[] = []
    const others: string[] = []
    for (const tok of p.slugTokens) {
      if (cityTokens.has(tok)) cities.push(tok)
      else if (tok.length >= 4) others.push(tok)
    }
    if (cityTokens.size > 0 && cities.length === 0) continue
    // Without targetMarkets we only group by two shared service nouns.
    const locKeys = cityTokens.size > 0 ? cities : ["__no_loc__"]
    for (const loc of locKeys) {
      for (const noun of others) {
        const key = `${loc}::${noun}`
        const list = buckets.get(key) ?? []
        if (!list.some((q) => q.url === p.url)) list.push(p)
        buckets.set(key, list)
      }
    }
  }
  const seen = new Set<string>()
  for (const [, group] of buckets) {
    if (group.length < 2) continue
    const fingerprint = group
      .map((g) => g.url)
      .sort()
      .join("|")
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)
    out.push({
      cluster: group.map((g) => g.url),
      sharedSignal: "url_pattern",
      recommendationHint: "differentiate_intent",
    })
  }
  return out
}

function detectSerpOverlap(
  pages: ReadonlyArray<NormalizedPage>,
  gscQueryPages: ReadonlyArray<GSCQueryRow> | undefined,
): CannibalizationCluster[] {
  if (!gscQueryPages || gscQueryPages.length === 0) return []
  const knownUrls = new Set(pages.map((p) => p.url))
  // Allow GSC-page → crawled-page matching by URL with/without trailing
  // slash, since GSC normalizes slashes inconsistently across reports.
  const matchToCrawl = (gscPage: string): string | null => {
    if (knownUrls.has(gscPage)) return gscPage
    const trimmed = gscPage.replace(/\/+$/, "")
    if (knownUrls.has(trimmed)) return trimmed
    if (knownUrls.has(`${trimmed}/`)) return `${trimmed}/`
    return null
  }
  // query → list of (page, position) within top N
  const byQuery = new Map<string, { page: string; position: number }[]>()
  for (const row of gscQueryPages) {
    if (row.position < 1 || row.position > SERP_OVERLAP_TOP_N) continue
    const matched = matchToCrawl(row.page)
    if (!matched) continue
    const list = byQuery.get(row.query) ?? []
    list.push({ page: matched, position: row.position })
    byQuery.set(row.query, list)
  }
  const out: CannibalizationCluster[] = []
  for (const [query, hits] of byQuery) {
    if (hits.length < 2) continue
    // Find any pair within SERP_OVERLAP_POS_DELTA; if found, output the
    // whole hit list as one cluster (still a single competing-query group).
    let competing = false
    for (let i = 0; i < hits.length && !competing; i++) {
      for (let j = i + 1; j < hits.length; j++) {
        if (Math.abs(hits[i].position - hits[j].position) <= SERP_OVERLAP_POS_DELTA) {
          competing = true
          break
        }
      }
    }
    if (!competing) continue
    const urls = Array.from(new Set(hits.map((h) => h.page)))
    if (urls.length < 2) continue
    out.push({
      cluster: urls,
      sharedSignal: "serp_overlap",
      topQuery: query,
      recommendationHint: "consolidate_to_stronger",
    })
  }
  return out
}

// ── Public API ────────────────────────────────────────────────────────────

const SIGNAL_PRIORITY: Record<CannibalizationSignal, number> = {
  identical_title: 0,
  serp_overlap: 1,
  title_similarity: 2,
  url_pattern: 3,
}

function dedupe(
  clusters: ReadonlyArray<CannibalizationCluster>,
): CannibalizationCluster[] {
  // Same URL-set → keep the highest-priority signal.
  const byKey = new Map<string, CannibalizationCluster>()
  for (const c of clusters) {
    if (c.cluster.length < 2) continue
    const key = [...c.cluster].sort().join("|")
    const existing = byKey.get(key)
    if (
      !existing ||
      SIGNAL_PRIORITY[c.sharedSignal] < SIGNAL_PRIORITY[existing.sharedSignal]
    ) {
      byKey.set(key, c)
    }
  }
  return Array.from(byKey.values())
}

export function detectCannibalization(params: {
  pages: ReadonlyArray<CrawledPage>
  partnerName?: string | null
  gscQueryPages?: ReadonlyArray<GSCQueryRow>
  targetMarkets?: ReadonlyArray<TargetMarket>
}): CannibalizationCluster[] {
  const okPages = params.pages.filter(
    (p) => p.status >= 200 && p.status < 300 && (p.title || p.finalUrl),
  )
  if (okPages.length < 2) return []

  const titles = okPages.map((p) => p.title ?? "")
  const brand =
    params.partnerName && params.partnerName.trim().length > 0
      ? params.partnerName.trim()
      : inferBrandSuffix(titles)
  const normalized = okPages.map((p) => normalizePage(p, brand))

  const all = [
    ...detectIdenticalTitle(normalized),
    ...detectSerpOverlap(normalized, params.gscQueryPages),
    ...detectTitleSimilarity(normalized),
    ...detectUrlPattern(normalized, params.targetMarkets),
  ]
  return dedupe(all)
}
