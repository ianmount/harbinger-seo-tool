import "server-only"
import type { CrawlResults } from "@/lib/types"

/**
 * Internal-linking analysis for the Audit tab.
 *
 * Inputs the same `CrawlResults` shape every other audit analysis consumes.
 * Outputs a 0-100 health score plus 0-N actionable recommendations the
 * dashboard can render alongside the supporting numbers (orphan pages,
 * link-poor pages, etc.).
 *
 * Scope intentionally narrow:
 *   - "Orphan pages"   = OK pages that no other OK page links to.
 *   - "Link-poor"      = OK pages with < 3 outbound internal links.
 *   - "Hub pages"      = OK pages in the top decile of incoming links.
 *   - "Avg out / in"   = sitewide averages, dropping the 0-link tail.
 *
 * Scoring (additive, capped at 100):
 *   start at 100
 *     - subtract 1 point per percent-of-pages that are orphans (max -40)
 *     - subtract 1 point per percent-of-pages that are link-poor (max -30)
 *     - subtract 20 if the average out-degree is below 5
 *     - subtract 10 if the homepage links to fewer than 5 of the top hubs
 *
 * The score is a directional signal — the synthesis prompt should still
 * cite specific URLs, not the score itself.
 */

export interface InternalLinkRecommendation {
  /** Stable identifier so the synthesis layer can cross-reference. */
  id:
    | "orphan_pages"
    | "link_poor_pages"
    | "low_average_out_degree"
    | "weak_homepage_hub"
    | "balanced_internal_links"
  title: string
  detail: string
  /** Up to 5 example URLs the recommendation applies to. */
  exampleUrls: string[]
}

export interface InternalLinkReport {
  /** Total OK pages considered (200-status pages from the crawl). */
  pagesAnalyzed: number
  /** Mean internal out-links per OK page (rounded to one decimal). */
  averageOutLinks: number
  /** Mean internal in-links per OK page (rounded to one decimal). */
  averageInLinks: number
  /** OK pages that no other OK page links to. */
  orphanPages: string[]
  /** OK pages with fewer than LINK_POOR_THRESHOLD outbound internal links. */
  linkPoorPages: { url: string; outLinks: number }[]
  /** Top-incoming-link pages on the site. */
  hubPages: { url: string; inLinks: number }[]
  /** 0-100; higher is healthier. */
  score: number
  recommendations: InternalLinkRecommendation[]
}

const LINK_POOR_THRESHOLD = 3
const ORPHAN_PENALTY_CAP = 40
const LINK_POOR_PENALTY_CAP = 30
const HUB_LIST_SIZE = 10

function normalizeUrl(url: string): string {
  // Strip trailing slash + fragment so `/foo` and `/foo/` and `/foo#x` all
  // collapse to the same canonical form for the in-degree count. The same
  // normalization runs on both source and target sides so cross-references
  // line up regardless of how the page was linked.
  try {
    const u = new URL(url)
    let path = u.pathname.replace(/\/+$/, "")
    if (path === "") path = "/"
    return `${u.origin}${path}`
  } catch {
    return url
  }
}

export function analyzeInternalLinks(crawl: CrawlResults): InternalLinkReport {
  const okPages = crawl.pages.filter(
    (p) => p.status >= 200 && p.status < 300,
  )
  if (okPages.length === 0) {
    return {
      pagesAnalyzed: 0,
      averageOutLinks: 0,
      averageInLinks: 0,
      orphanPages: [],
      linkPoorPages: [],
      hubPages: [],
      score: 0,
      recommendations: [],
    }
  }

  const okUrlSet = new Set<string>()
  for (const page of okPages) {
    okUrlSet.add(normalizeUrl(page.finalUrl || page.url))
  }

  const inDegree = new Map<string, number>()
  for (const url of okUrlSet) inDegree.set(url, 0)

  let totalOutLinks = 0
  const outDegreeByUrl = new Map<string, number>()
  for (const page of okPages) {
    const sourceUrl = normalizeUrl(page.finalUrl || page.url)
    const distinctTargets = new Set<string>()
    for (const link of page.internalLinksOut) {
      const target = normalizeUrl(link)
      // Only count links pointing to other OK pages on the same site to
      // exclude broken links and external URLs from the in-degree map.
      if (target === sourceUrl) continue
      if (!okUrlSet.has(target)) continue
      distinctTargets.add(target)
    }
    outDegreeByUrl.set(sourceUrl, distinctTargets.size)
    totalOutLinks += distinctTargets.size
    for (const target of distinctTargets) {
      inDegree.set(target, (inDegree.get(target) ?? 0) + 1)
    }
  }

  const totalPages = okPages.length

  const orphanPages: string[] = []
  for (const [url, deg] of inDegree) {
    if (deg === 0) orphanPages.push(url)
  }
  orphanPages.sort()

  const linkPoorPages: { url: string; outLinks: number }[] = []
  for (const [url, out] of outDegreeByUrl) {
    if (out < LINK_POOR_THRESHOLD) {
      linkPoorPages.push({ url, outLinks: out })
    }
  }
  linkPoorPages.sort((a, b) => a.outLinks - b.outLinks || a.url.localeCompare(b.url))

  const hubPages: { url: string; inLinks: number }[] = [...inDegree.entries()]
    .map(([url, inLinks]) => ({ url, inLinks }))
    .sort((a, b) => b.inLinks - a.inLinks || a.url.localeCompare(b.url))
    .slice(0, HUB_LIST_SIZE)

  const totalInLinks = [...inDegree.values()].reduce((s, n) => s + n, 0)
  const averageOutLinks = Number((totalOutLinks / totalPages).toFixed(1))
  const averageInLinks = Number((totalInLinks / totalPages).toFixed(1))

  const orphanPct = (orphanPages.length / totalPages) * 100
  const linkPoorPct = (linkPoorPages.length / totalPages) * 100

  let score = 100
  score -= Math.min(ORPHAN_PENALTY_CAP, Math.round(orphanPct))
  score -= Math.min(LINK_POOR_PENALTY_CAP, Math.round(linkPoorPct))
  if (averageOutLinks < 5) score -= 20

  const homepage = okPages.find((p) => {
    try {
      return new URL(p.finalUrl || p.url).pathname.replace(/\/$/, "") === ""
    } catch {
      return false
    }
  })
  if (homepage) {
    const homepageUrl = normalizeUrl(homepage.finalUrl || homepage.url)
    const homepageOut = new Set(
      homepage.internalLinksOut.map(normalizeUrl).filter(
        (u) => u !== homepageUrl && okUrlSet.has(u),
      ),
    )
    const topHubUrls = new Set(hubPages.map((h) => h.url))
    let homepageHubLinks = 0
    for (const u of homepageOut) if (topHubUrls.has(u)) homepageHubLinks++
    if (hubPages.length >= 5 && homepageHubLinks < 5) {
      score -= 10
    }
  }
  score = Math.max(0, Math.min(100, score))

  const recommendations: InternalLinkRecommendation[] = []
  if (orphanPages.length > 0) {
    recommendations.push({
      id: "orphan_pages",
      title: `${orphanPages.length} orphan page${orphanPages.length === 1 ? "" : "s"} (no incoming internal links)`,
      detail:
        "Add at least one contextual internal link from a related page or hub. Orphan pages can't pass topical authority and rarely rank.",
      exampleUrls: orphanPages.slice(0, 5),
    })
  }
  if (linkPoorPages.length > 0) {
    recommendations.push({
      id: "link_poor_pages",
      title: `${linkPoorPages.length} page${linkPoorPages.length === 1 ? "" : "s"} link to fewer than ${LINK_POOR_THRESHOLD} other internal pages`,
      detail:
        "Thin out-link counts limit crawl flow and topical clustering. Add 3-5 contextual links to related pages (services, locations, recent posts).",
      exampleUrls: linkPoorPages.slice(0, 5).map((p) => p.url),
    })
  }
  if (averageOutLinks < 5) {
    recommendations.push({
      id: "low_average_out_degree",
      title: `Average outbound internal links is ${averageOutLinks} per page`,
      detail:
        "Healthy local-services sites land between 8 and 25 out-links per page (nav + footer + 3-5 in-body). Audit your nav/footer and add contextual body links where missing.",
      exampleUrls: [],
    })
  }
  if (
    homepage &&
    hubPages.length >= 5 &&
    recommendations.some((r) => r.id === "low_average_out_degree") === false
  ) {
    const homepageUrl = normalizeUrl(homepage.finalUrl || homepage.url)
    const homepageOut = new Set(
      homepage.internalLinksOut.map(normalizeUrl).filter(
        (u) => u !== homepageUrl && okUrlSet.has(u),
      ),
    )
    const topHubUrls = new Set(hubPages.map((h) => h.url))
    let homepageHubLinks = 0
    for (const u of homepageOut) if (topHubUrls.has(u)) homepageHubLinks++
    if (homepageHubLinks < 5) {
      recommendations.push({
        id: "weak_homepage_hub",
        title: "Homepage links to fewer than 5 of the site's top internal hubs",
        detail:
          "The homepage carries the strongest internal authority. Link directly to the most-linked-to pages (top services, primary locations) so authority flows where it matters.",
        exampleUrls: hubPages.slice(0, 5).map((h) => h.url),
      })
    }
  }
  if (recommendations.length === 0) {
    recommendations.push({
      id: "balanced_internal_links",
      title: "Internal linking is balanced",
      detail:
        "No orphan pages, healthy out-link counts, and the homepage links to your top hubs. Maintain this when shipping new pages by adding 3-5 contextual links from the closest existing parent.",
      exampleUrls: [],
    })
  }

  return {
    pagesAnalyzed: totalPages,
    averageOutLinks,
    averageInLinks,
    orphanPages,
    linkPoorPages,
    hubPages,
    score,
    recommendations,
  }
}
