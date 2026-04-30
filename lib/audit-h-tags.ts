import type { CrawlReport } from "@/lib/types"

/**
 * Heading-structure analysis. Detects three patterns Claude needs to flag:
 *   - pages missing an H1 entirely (Google uses the first H1 as a strong
 *     topical signal — its absence is a soft ranking penalty)
 *   - pages with multiple H1s (legacy site-builder behavior; ambiguates
 *     the page's primary topic for crawlers)
 *   - pages missing every H2 (no document outline — readability + scan
 *     issues that hurt time-on-page)
 *
 * Only OK pages (status 2xx/3xx, no fetch error) are analyzed; non-OK
 * pages are scored elsewhere and a missing H1 on a 404 isn't a finding.
 */

export interface HeadingIssueSample {
  url: string
}

export interface HeadingMultipleH1Sample {
  url: string
  h1Count: number
  h1s: string[]
}

export interface HeadingIssues {
  okPagesAnalyzed: number
  pagesWithoutH1: HeadingIssueSample[]
  pagesWithMultipleH1: HeadingMultipleH1Sample[]
  pagesWithoutH2: HeadingIssueSample[]
  /** Share of OK pages that have ≥1 H1 (0–1). */
  h1CoverageRate: number
  /** Share of OK pages that have ≥1 H2 (0–1). */
  h2CoverageRate: number
}

export function detectHeadingIssues(crawl: CrawlReport): HeadingIssues {
  const okPages = crawl.pages.filter(
    (p) => p.status >= 200 && p.status < 400 && !p.error,
  )
  const okPagesAnalyzed = okPages.length

  const pagesWithoutH1: HeadingIssueSample[] = []
  const pagesWithMultipleH1: HeadingMultipleH1Sample[] = []
  const pagesWithoutH2: HeadingIssueSample[] = []

  for (const p of okPages) {
    const h1s = p.h1s ?? []
    const h2s = p.h2s ?? []
    if (h1s.length === 0) {
      pagesWithoutH1.push({ url: p.url })
    } else if (h1s.length > 1) {
      pagesWithMultipleH1.push({
        url: p.url,
        h1Count: h1s.length,
        h1s: h1s.slice(0, 3),
      })
    }
    if (h2s.length === 0) {
      pagesWithoutH2.push({ url: p.url })
    }
  }

  const h1CoverageRate =
    okPagesAnalyzed > 0
      ? (okPagesAnalyzed - pagesWithoutH1.length) / okPagesAnalyzed
      : 0
  const h2CoverageRate =
    okPagesAnalyzed > 0
      ? (okPagesAnalyzed - pagesWithoutH2.length) / okPagesAnalyzed
      : 0

  return {
    okPagesAnalyzed,
    pagesWithoutH1,
    pagesWithMultipleH1,
    pagesWithoutH2,
    h1CoverageRate,
    h2CoverageRate,
  }
}
