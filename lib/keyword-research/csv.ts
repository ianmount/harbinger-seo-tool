/**
 * Per-location CSV builder for the keyword-research deliverable.
 *
 * Column order (confirmed with the user — exactly these five):
 *   Seed/Category, Keyword, Source, Search Volume, Current Rank
 *
 * "Search Volume" is the CITY-level number (google_ads/search_volume scoped to
 * the location). "Current Rank" is the target's organic position in that city;
 * null renders "Not in top 20". Rows are sorted by Seed, then Search Volume
 * descending — matching the skill's output.
 */

import type { KeywordResearchLocationResult } from "@/lib/types"

const HEADERS = [
  "Seed/Category",
  "Keyword",
  "Source",
  "Search Volume",
  "Current Rank",
] as const

function escapeCell(value: string | number | null): string {
  if (value == null) return ""
  const s = String(value)
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

export function buildLocationCsv(loc: KeywordResearchLocationResult): string {
  const rows = [...loc.rows].sort((a, b) => {
    if (a.seed !== b.seed) return a.seed.localeCompare(b.seed)
    return (b.cityVolume ?? 0) - (a.cityVolume ?? 0)
  })

  const lines: string[] = [HEADERS.join(",")]
  for (const r of rows) {
    lines.push(
      [
        escapeCell(r.seed),
        escapeCell(r.keyword),
        escapeCell(r.source),
        escapeCell(r.cityVolume),
        escapeCell(r.currentRank == null ? "Not in top 20" : r.currentRank),
      ].join(","),
    )
  }
  // Trailing newline so the file ends cleanly.
  return `${lines.join("\n")}\n`
}

/** Filename for a location CSV, e.g. "hiremrright_atlanta-ga_keywords.csv". */
export function locationCsvFilename(prefix: string, slug: string): string {
  const safePrefix = prefix
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return `${safePrefix || "keywords"}_${slug}_keywords.csv`
}
