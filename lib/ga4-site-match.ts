import type { GA4PropertyInfo } from "@/lib/types"
import { extractHostname } from "@/lib/gsc-site-match"

/**
 * Pure matcher that takes a partner's website string and a list of GA4
 * properties the authed account can access, and returns the subset whose
 * primary web-stream URL matches the partner's apex domain.
 *
 * No server-only imports so this can be used from client components. Mirrors
 * `lib/gsc-site-match.ts` in spirit so the two tabs use the same resolution
 * model. Properties without a resolved `websiteUrl` are always excluded —
 * we can't match something we don't have.
 *
 * Rank within a match group: shorter `websiteUrl` first (usually the apex),
 * then displayName alphabetical so the ordering is deterministic across
 * reloads even when two properties share a domain.
 */

function normalizeHost(host: string): string {
  return host.replace(/^www\./i, "").toLowerCase()
}

function hostnameFromWebsiteUrl(url: string): string | null {
  try {
    return normalizeHost(new URL(url).hostname)
  } catch {
    // Some stream URIs are stored without a scheme ("example.com"). Fall
    // back to the simpler extractor so we still match those.
    return extractHostname(url) || null
  }
}

export function findGa4PropertyCandidates(
  website: string,
  properties: readonly GA4PropertyInfo[],
): GA4PropertyInfo[] {
  const target = extractHostname(website)
  if (!target) return []
  return properties
    .filter((p) => {
      if (!p.websiteUrl) return false
      const host = hostnameFromWebsiteUrl(p.websiteUrl)
      return host === target
    })
    .sort((a, b) => {
      const la = a.websiteUrl?.length ?? Infinity
      const lb = b.websiteUrl?.length ?? Infinity
      if (la !== lb) return la - lb
      return a.displayName.localeCompare(b.displayName)
    })
}

export function findBestGa4Property(
  website: string,
  properties: readonly GA4PropertyInfo[],
): GA4PropertyInfo | null {
  return findGa4PropertyCandidates(website, properties)[0] ?? null
}
