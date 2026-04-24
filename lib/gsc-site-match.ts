import type { GSCSiteInfo } from "@/lib/types"

/**
 * Pure matcher that takes a partner's website string and a list of GSC
 * properties the authed account can access, and returns the subset that
 * match the partner's apex domain. No server-only imports so this can be
 * used from client components.
 *
 * A single apex domain may show up multiple times in a Search Console
 * account: `sc-domain:example.com`, `https://example.com/`,
 * `https://www.example.com/`, `http://example.com/`. Domain properties
 * capture more data (all subdomains, all protocols), so we rank them first.
 * Within the same rank, stronger permissions come first.
 */

function normalizeHost(host: string): string {
  return host.replace(/^www\./i, "").toLowerCase()
}

/** Extract an apex-ish hostname from a freeform website string. */
export function extractHostname(website: string): string {
  let s = website.trim()
  s = s.replace(/^https?:\/\//i, "")
  s = s.replace(/\/.*$/, "")
  return normalizeHost(s)
}

/** Extract the hostname from a GSC siteUrl (either sc-domain: or URL-prefix). */
export function hostnameFromGscSiteUrl(siteUrl: string): string | null {
  if (siteUrl.startsWith("sc-domain:")) {
    return normalizeHost(siteUrl.slice("sc-domain:".length))
  }
  try {
    return normalizeHost(new URL(siteUrl).hostname)
  } catch {
    return null
  }
}

function permissionRank(level: string): number {
  switch (level) {
    case "siteOwner":
      return 0
    case "siteFullUser":
      return 1
    case "siteRestrictedUser":
      return 2
    case "siteUnverifiedUser":
      return 3
    default:
      return 4
  }
}

function formRank(siteUrl: string): number {
  if (siteUrl.startsWith("sc-domain:")) return 0
  if (siteUrl.startsWith("https://")) return 1
  if (siteUrl.startsWith("http://")) return 2
  return 3
}

/** All GSC properties whose hostname matches the partner's website. */
export function findGscSiteCandidates(
  website: string,
  sites: GSCSiteInfo[],
): GSCSiteInfo[] {
  const target = extractHostname(website)
  if (!target) return []
  return sites
    .filter((s) => hostnameFromGscSiteUrl(s.siteUrl) === target)
    .sort((a, b) => {
      const f = formRank(a.siteUrl) - formRank(b.siteUrl)
      if (f !== 0) return f
      const p = permissionRank(a.permissionLevel) - permissionRank(b.permissionLevel)
      if (p !== 0) return p
      return a.siteUrl.localeCompare(b.siteUrl)
    })
}

/** Highest-ranked candidate, or null when nothing matches. */
export function findBestGscSite(
  website: string,
  sites: GSCSiteInfo[],
): string | null {
  return findGscSiteCandidates(website, sites)[0]?.siteUrl ?? null
}
