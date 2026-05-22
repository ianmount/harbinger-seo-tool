import type { PartnerArtifact, PartnerArtifactKind } from "@/lib/types"

/**
 * Per-kind export framework for saved artifacts.
 *
 * Only CSV exports are file-downloaded — PDF is handled separately by
 * the artifact detail page via `window.print()` (every kind is
 * printable since the page already renders the view). JSON is no
 * longer offered as a file download; the raw payload is accessible via
 * the collapsible "Raw data" disclosure under each rich view.
 *
 *   • List kinds (keyword_list, faq_research, backlink_prospects,
 *     referring_domains, backlink_trends, organic_rankings,
 *     competitive_analysis) → CSV.
 *   • Everything else → no file export; the visual dashboard is
 *     captured via the "Save as PDF" button instead.
 */

export type ExportFormat = "csv"

export interface ArtifactExport {
  format: ExportFormat
  /** Human label for the download button: "Download CSV". */
  label: string
  filename: string
  mimeType: string
  /** Lazy content generator. */
  build: () => string
}

// ── Tiny utilities ─────────────────────────────────────────────────────────

function safeFilename(name: string, ext: string): string {
  const cleaned =
    name.replace(/[^a-z0-9-_]+/gi, "_").replace(/_+/g, "_").slice(0, 80) ||
    "artifact"
  return `${cleaned}.${ext}`
}

/**
 * CSV-escape: wrap in quotes if value contains comma, quote, newline, or
 * leading/trailing whitespace; double internal quotes.
 */
function csvCell(v: unknown): string {
  if (v == null) return ""
  const s = String(v)
  if (/[,"\n\r]|^\s|\s$/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

function csvRow(values: readonly unknown[]): string {
  return values.map(csvCell).join(",")
}

function csvBlob(headers: readonly string[], rows: readonly unknown[][]): string {
  return [csvRow(headers), ...rows.map((r) => csvRow(r))].join("\n")
}

function asObject(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null
    ? (v as Record<string, unknown>)
    : {}
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

// ── Tabular: keyword_list ──────────────────────────────────────────────────

interface KeywordRow {
  keyword: string
  search_volume?: number
  keyword_difficulty?: number
  cpc?: number
  competition_level?: string
  intent?: string
}

function isKeywordRow(v: unknown): v is KeywordRow {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Record<string, unknown>).keyword === "string"
  )
}

function buildKeywordListCsv(artifact: PartnerArtifact): string {
  const data = asObject(artifact.data)
  // Prefer the user's selected subset when present, otherwise the full rows.
  const selected = asArray(data.selectedKeywords).filter(isKeywordRow)
  const all = asArray(data.rows).filter(isKeywordRow)
  const rows = selected.length > 0 ? selected : all
  return csvBlob(
    ["keyword", "search_volume", "keyword_difficulty", "cpc", "intent"],
    rows.map((r) => [
      r.keyword,
      r.search_volume ?? "",
      r.keyword_difficulty ?? "",
      r.cpc ?? "",
      r.intent ?? r.competition_level ?? "",
    ]),
  )
}

// ── Tabular fallback ───────────────────────────────────────────────────────
//
// For kinds whose canonical writer hasn't been wired yet, inspect the
// payload defensively, pick an `items` / `rows` / `prospects` field if
// one looks like an array of objects, and emit the union of keys as
// columns. As specific writers register their own shapes, swap these
// out for purpose-built generators.

function genericRowsCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return ""
  const keySet = new Set<string>()
  for (const r of rows) for (const k of Object.keys(r)) keySet.add(k)
  const keys = [...keySet]
  return csvBlob(
    keys,
    rows.map((r) => keys.map((k) => r[k] ?? "")),
  )
}

function pickRowArray(data: Record<string, unknown>): Record<string, unknown>[] {
  const candidates = [
    "rows",
    "items",
    "prospects",
    "questions",
    "competitors",
    "domains",
    "results",
  ]
  for (const key of candidates) {
    const v = data[key]
    if (Array.isArray(v) && v.every((x) => typeof x === "object" && x !== null)) {
      return v as Record<string, unknown>[]
    }
  }
  return []
}

// ── Public: per-artifact export list ───────────────────────────────────────

/** Kinds that produce list-shaped outputs and should offer a CSV export. */
const CSV_KINDS: ReadonlySet<PartnerArtifactKind> = new Set([
  "keyword_list",
  "faq_research",
  "backlink_prospects",
  "referring_domains",
  "backlink_trends",
  "competitive_analysis",
  "organic_rankings",
])

export function getArtifactExports(
  artifact: PartnerArtifact,
): ArtifactExport[] {
  if (!CSV_KINDS.has(artifact.kind)) return []

  if (artifact.kind === "keyword_list") {
    return [
      {
        format: "csv",
        label: "Download CSV",
        filename: safeFilename(artifact.title, "csv"),
        mimeType: "text/csv;charset=utf-8",
        build: () => buildKeywordListCsv(artifact),
      },
    ]
  }

  const rows = pickRowArray(asObject(artifact.data))
  if (rows.length === 0) return []
  return [
    {
      format: "csv",
      label: "Download CSV",
      filename: safeFilename(artifact.title, "csv"),
      mimeType: "text/csv;charset=utf-8",
      build: () => genericRowsCsv(rows),
    },
  ]
}
