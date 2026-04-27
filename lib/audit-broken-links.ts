import "server-only"
import type { CrawlResults } from "@/lib/types"

/**
 * Broken-internal-link detector for the Audit tab.
 *
 * Scope: cross-references each crawled page's `internalLinksOut` against
 * the set of URLs that came back 4xx/5xx during the same crawl
 * (`crawl.nonOkPages`). A target is reported only when at least one
 * other crawled page links to it — broken pages with no incoming
 * internal links exist but they're not as urgent and the synthesis
 * already covers them via the crawl's status-code distribution.
 *
 * Typo detection: when a broken slug differs from a 200-status sibling
 * (same parent path) by ≤ 2 character edits, the sibling is reported as
 * `likelyTypoOf`. Example: `/locations/brandenton-beach` (404) →
 * `/locations/bradenton-beach` (200).
 */

export interface BrokenInternalLinkTarget {
  brokenUrl: string
  statusCode: number
  /** Crawled pages whose `internalLinksOut` references the broken URL. */
  sourcePages: string[]
  sourceCount: number
  /** Suggested correction when Levenshtein distance ≤ 2 against an OK sibling. */
  likelyTypoOf?: string
}

export interface BrokenInternalLinks {
  totalBrokenLinks: number
  brokenTargets: BrokenInternalLinkTarget[]
}

const TYPO_DISTANCE_LIMIT = 2

/**
 * Levenshtein distance with an early-exit when the running min on a row
 * already exceeds `max`. Returns `max + 1` in that case so callers don't
 * pay the full DP for long mismatches.
 */
function levenshtein(a: string, b: string, max: number): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1
  const al = a.length
  const bl = b.length
  let prev = new Array<number>(bl + 1)
  let curr = new Array<number>(bl + 1)
  for (let j = 0; j <= bl; j++) prev[j] = j
  for (let i = 1; i <= al; i++) {
    curr[0] = i
    let rowMin = curr[0]
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
      if (curr[j] < rowMin) rowMin = curr[j]
    }
    if (rowMin > max) return max + 1
    ;[prev, curr] = [curr, prev]
  }
  return prev[bl]
}

function parentPath(url: string): string | null {
  try {
    const u = new URL(url)
    const parts = u.pathname.split("/").filter(Boolean)
    if (parts.length < 1) return null
    return "/" + parts.slice(0, -1).join("/")
  } catch {
    return null
  }
}

function leafSlug(url: string): string {
  try {
    const u = new URL(url)
    const parts = u.pathname.split("/").filter(Boolean)
    return parts[parts.length - 1] ?? ""
  } catch {
    return ""
  }
}

export function detectBrokenInternalLinks(
  crawl: CrawlResults,
): BrokenInternalLinks {
  const brokenStatusByUrl = new Map<string, number>()
  for (const np of crawl.nonOkPages) {
    if (np.status >= 400 && np.status < 600) {
      brokenStatusByUrl.set(np.url, np.status)
    }
  }
  if (brokenStatusByUrl.size === 0) {
    return { totalBrokenLinks: 0, brokenTargets: [] }
  }

  const brokenToSources = new Map<string, Set<string>>()
  for (const page of crawl.pages) {
    if (page.status < 200 || page.status >= 300) continue
    const sourceUrl = page.finalUrl || page.url
    for (const target of page.internalLinksOut) {
      if (brokenStatusByUrl.has(target)) {
        const set = brokenToSources.get(target) ?? new Set<string>()
        set.add(sourceUrl)
        brokenToSources.set(target, set)
      }
    }
  }

  // Group OK URLs by parent path so typo lookup only compares against
  // same-directory siblings — `/services/foo` won't be suggested as a
  // correction for `/locations/fooo`.
  const okByParent = new Map<string, string[]>()
  for (const page of crawl.pages) {
    if (page.status < 200 || page.status >= 300) continue
    const url = page.finalUrl || page.url
    const parent = parentPath(url)
    if (!parent) continue
    const arr = okByParent.get(parent) ?? []
    arr.push(url)
    okByParent.set(parent, arr)
  }

  const brokenTargets: BrokenInternalLinkTarget[] = []
  for (const [brokenUrl, statusCode] of brokenStatusByUrl) {
    const sources = brokenToSources.get(brokenUrl)
    if (!sources || sources.size === 0) continue

    const parent = parentPath(brokenUrl)
    const slug = leafSlug(brokenUrl)
    let likelyTypoOf: string | undefined
    if (parent && slug) {
      const candidates = okByParent.get(parent) ?? []
      let bestDist = TYPO_DISTANCE_LIMIT + 1
      let bestUrl: string | null = null
      for (const okUrl of candidates) {
        const okSlug = leafSlug(okUrl)
        if (okSlug === slug) continue
        const dist = levenshtein(slug, okSlug, TYPO_DISTANCE_LIMIT)
        if (dist < bestDist) {
          bestDist = dist
          bestUrl = okUrl
        }
      }
      if (bestUrl && bestDist <= TYPO_DISTANCE_LIMIT) likelyTypoOf = bestUrl
    }

    brokenTargets.push({
      brokenUrl,
      statusCode,
      sourcePages: [...sources].sort(),
      sourceCount: sources.size,
      ...(likelyTypoOf ? { likelyTypoOf } : {}),
    })
  }

  brokenTargets.sort((a, b) => b.sourceCount - a.sourceCount)
  return { totalBrokenLinks: brokenTargets.length, brokenTargets }
}
