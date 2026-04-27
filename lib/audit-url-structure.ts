import "server-only"
import type { CrawledPage, CrawlResults } from "@/lib/types"

/**
 * URL-structure conflict detector for the Audit tab.
 *
 * Surfaces two patterns that hurt SEO on local-service-business sites:
 *
 *   1. **Parallel structure** — the site uses two top-level path segments
 *      that mean the same thing (e.g. `/locations/` AND `/areas-served/`).
 *      Search engines split equity between them and the prospect typically
 *      ranks with neither.
 *   2. **Child collisions** — within a parallel structure, the same
 *      trailing slug exists under both parents (`/locations/charlotte`
 *      AND `/areas-served/charlotte`). High-confidence duplicate content;
 *      title + H1 token similarity is reported so the synthesis prompt
 *      can quantify how copy-paste the duplication actually is.
 *
 * The clusters below enumerate the parallel patterns we recognize. The
 * detector does NOT opine on every URL choice — it surfaces these known,
 * high-value gotchas only.
 */

/** Top-level segments that the detector treats as semantically equivalent. */
const PARALLEL_GROUPS: Record<string, string[]> = {
  locations: [
    "locations",
    "areas-served",
    "service-areas",
    "cities",
    "where-we-serve",
  ],
  services: ["services", "our-services", "what-we-do", "offerings"],
  blog: ["blog", "articles", "posts", "news", "insights"],
  about: ["about", "about-us", "company", "who-we-are"],
}

export interface ParallelStructureConflict {
  /** Cluster name from PARALLEL_GROUPS (e.g. "locations"). */
  cluster: string
  /** Top-level segments observed on the site within this cluster. */
  segments: string[]
  /** Distinct child slugs found under each segment. */
  childCountPerSegment: Record<string, number>
  /** Slugs that exist under 2+ of the parallel segments. */
  sampleOverlappingSlugs: string[]
}

export interface ChildCollision {
  /** Trailing slug shared by 2+ paths (e.g. "bradenton-beach"). */
  slug: string
  /** Absolute URLs under the parallel segments that share the slug. */
  paths: string[]
  /** Title per path (null when missing). */
  titles: Record<string, string | null>
  /** First H1 per path (null when missing). */
  h1s: Record<string, string | null>
  /**
   * Average pairwise Jaccard similarity over title+H1 token sets across
   * the colliding paths. 0 = unrelated, 1 = identical. The synthesis
   * prompt uses this to call out high-confidence duplicates separately
   * from cases where the slug is shared but the page is genuinely
   * different.
   */
  similarityScore: number
}

export interface UrlStructureIssues {
  parallelStructures: ParallelStructureConflict[]
  childCollisions: ChildCollision[]
}

function topLevelSegment(url: string): string | null {
  try {
    const u = new URL(url)
    const parts = u.pathname.split("/").filter(Boolean)
    return parts[0]?.toLowerCase() ?? null
  } catch {
    return null
  }
}

function trailingSlug(url: string): string | null {
  try {
    const u = new URL(url)
    const parts = u.pathname.split("/").filter(Boolean)
    return parts.length >= 2 ? parts[1].toLowerCase() : null
  } catch {
    return null
  }
}

function tokenize(s: string | null): Set<string> {
  if (!s) return new Set()
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1),
  )
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let intersect = 0
  for (const t of a) if (b.has(t)) intersect++
  const union = a.size + b.size - intersect
  return union === 0 ? 0 : intersect / union
}

export function detectUrlStructureIssues(
  crawl: CrawlResults,
): UrlStructureIssues {
  const segmentToPages = new Map<string, CrawledPage[]>()
  for (const page of crawl.pages) {
    if (page.status < 200 || page.status >= 300) continue
    const seg = topLevelSegment(page.finalUrl || page.url)
    if (!seg) continue
    const arr = segmentToPages.get(seg) ?? []
    arr.push(page)
    segmentToPages.set(seg, arr)
  }

  const parallelStructures: ParallelStructureConflict[] = []
  const childCollisions: ChildCollision[] = []

  for (const [clusterName, segmentList] of Object.entries(PARALLEL_GROUPS)) {
    // A segment "counts" only when it has at least one child URL. A bare
    // /locations/ index page on its own isn't a parallel-structure problem.
    const present = segmentList.filter((s) => {
      const pages = segmentToPages.get(s) ?? []
      return pages.some((p) => trailingSlug(p.finalUrl || p.url) !== null)
    })
    if (present.length < 2) continue

    const childCountPerSegment: Record<string, number> = {}
    const slugsBySegment = new Map<string, Map<string, CrawledPage>>()
    for (const seg of present) {
      const pages = segmentToPages.get(seg) ?? []
      const slugMap = new Map<string, CrawledPage>()
      for (const p of pages) {
        const slug = trailingSlug(p.finalUrl || p.url)
        if (!slug) continue
        // First page wins per slug — collisions within a single segment
        // fall to the cannibalization detector, not this one.
        if (!slugMap.has(slug)) slugMap.set(slug, p)
      }
      childCountPerSegment[seg] = slugMap.size
      slugsBySegment.set(seg, slugMap)
    }

    // Find slugs that appear under 2+ of the parallel segments.
    const slugToSegments = new Map<string, string[]>()
    for (const [seg, slugMap] of slugsBySegment) {
      for (const slug of slugMap.keys()) {
        const arr = slugToSegments.get(slug) ?? []
        arr.push(seg)
        slugToSegments.set(slug, arr)
      }
    }
    const overlapping = [...slugToSegments.entries()].filter(
      ([, segs]) => segs.length >= 2,
    )

    parallelStructures.push({
      cluster: clusterName,
      segments: present,
      childCountPerSegment,
      sampleOverlappingSlugs: overlapping.map(([slug]) => slug).slice(0, 10),
    })

    for (const [slug, segs] of overlapping) {
      const paths: string[] = []
      const titles: Record<string, string | null> = {}
      const h1s: Record<string, string | null> = {}
      const collidingPages: CrawledPage[] = []
      for (const seg of segs) {
        const page = slugsBySegment.get(seg)?.get(slug)
        if (!page) continue
        const path = page.finalUrl || page.url
        paths.push(path)
        titles[path] = page.title
        h1s[path] = page.h1s[0] ?? null
        collidingPages.push(page)
      }
      let total = 0
      let pairs = 0
      for (let i = 0; i < collidingPages.length; i++) {
        for (let j = i + 1; j < collidingPages.length; j++) {
          const titleSim = jaccard(
            tokenize(collidingPages[i].title),
            tokenize(collidingPages[j].title),
          )
          const h1Sim = jaccard(
            tokenize(collidingPages[i].h1s[0] ?? null),
            tokenize(collidingPages[j].h1s[0] ?? null),
          )
          total += (titleSim + h1Sim) / 2
          pairs++
        }
      }
      const similarityScore = pairs === 0 ? 0 : total / pairs
      childCollisions.push({
        slug,
        paths,
        titles,
        h1s,
        similarityScore: Number(similarityScore.toFixed(3)),
      })
    }
  }

  return { parallelStructures, childCollisions }
}
