import type { BrandedQuerySplit, GSCTopQueryRow } from "@/lib/types"

/**
 * Branded vs non-branded GSC split. We can't ask the partner to maintain
 * a brand-token list, so we derive one heuristically from:
 *   - the partner's display name (token-split, drop generic suffixes
 *     like "Marketing", "LLC", "Services")
 *   - the apex domain (drop the TLD, keep substrings ≥3 chars)
 *
 * A query is "branded" if its lowercased text contains ANY token as a
 * substring. This intentionally over-classifies (e.g. a partner named
 * "Acme Plumbing" will mark "acme drain cleaning" as branded even
 * though the user typed "acme" generically). The alternative — under-
 * classifying — produces a more flattering branded share, which is
 * exactly the bias we want to avoid in a sales audit.
 *
 * When `partnerName` is empty/unknown and the apex contributes no
 * usable tokens, `brandTokens` is empty and every query falls into
 * the non-branded bucket. The synthesis prompt acknowledges that gap
 * explicitly so Claude doesn't fabricate a split.
 */

const BRAND_STOPWORDS = new Set([
  "the", "and", "of", "for", "in", "on",
  "co", "company", "inc", "llc", "ltd", "corp", "corporation",
  "services", "service", "marketing", "agency",
  "group", "team",
  "com", "net", "org", "co",
])

/** Re-export of the shared shape for ergonomic local imports. */
export type BrandedSplit = BrandedQuerySplit

export function deriveBrandTokens(opts: {
  partnerName?: string | null
  websiteUrl: string
}): string[] {
  const tokens = new Set<string>()
  const name = (opts.partnerName ?? "").toLowerCase().trim()
  if (name) {
    for (const tok of name.split(/[^a-z0-9]+/)) {
      if (tok.length >= 3 && !BRAND_STOPWORDS.has(tok)) tokens.add(tok)
    }
  }
  // Apex domain → split TLD off, then split on dots/dashes/underscores.
  try {
    const u = new URL(
      opts.websiteUrl.startsWith("http")
        ? opts.websiteUrl
        : `https://${opts.websiteUrl}`,
    )
    const host = u.hostname.replace(/^www\./, "").toLowerCase()
    const parts = host.split(".")
    const apexParts = parts.length > 1 ? parts.slice(0, -1) : parts
    for (const seg of apexParts) {
      for (const tok of seg.split(/[-_]/)) {
        if (tok.length >= 3 && !BRAND_STOPWORDS.has(tok)) tokens.add(tok)
      }
    }
  } catch {
    /* invalid URL — fall back to whatever name tokens we got */
  }
  return Array.from(tokens)
}

export function splitBrandedQueries(
  topQueries: GSCTopQueryRow[],
  brandTokens: string[],
): BrandedQuerySplit {
  const branded: GSCTopQueryRow[] = []
  const nonBranded: GSCTopQueryRow[] = []

  if (brandTokens.length === 0) {
    for (const q of topQueries) nonBranded.push(q)
  } else {
    for (const q of topQueries) {
      const ql = q.query.toLowerCase()
      const isBranded = brandTokens.some((t) => ql.includes(t))
      if (isBranded) branded.push(q)
      else nonBranded.push(q)
    }
  }

  const totalClicks = topQueries.reduce((s, q) => s + q.clicks, 0)
  const totalImpr = topQueries.reduce((s, q) => s + q.impressions, 0)
  const brandedClicks = branded.reduce((s, q) => s + q.clicks, 0)
  const brandedImpr = branded.reduce((s, q) => s + q.impressions, 0)

  return {
    brandTokens,
    totalQueries: topQueries.length,
    brandedQueries: branded.length,
    nonBrandedQueries: nonBranded.length,
    brandedClicks,
    nonBrandedClicks: totalClicks - brandedClicks,
    brandedImpressions: brandedImpr,
    nonBrandedImpressions: totalImpr - brandedImpr,
    brandedSharePctClicks:
      totalClicks > 0 ? (brandedClicks / totalClicks) * 100 : 0,
    brandedSharePctImpressions:
      totalImpr > 0 ? (brandedImpr / totalImpr) * 100 : 0,
    topBrandedQueries: [...branded].sort((a, b) => b.clicks - a.clicks).slice(0, 15),
    topNonBrandedQueries: [...nonBranded]
      .sort((a, b) => b.clicks - a.clicks)
      .slice(0, 15),
  }
}
