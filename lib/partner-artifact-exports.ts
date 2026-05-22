import type { PartnerArtifact, PartnerArtifactKind } from "@/lib/types"

/**
 * Per-kind export framework for saved artifacts.
 *
 * Each artifact kind declares one or more export formats appropriate
 * to its shape. The detail page calls `getArtifactExports(artifact)`
 * to render a download button per available format.
 *
 *   • Tabular kinds (keyword_list, faq_research, backlink_prospects,
 *     competitive_analysis) ship CSV.
 *   • Narrative kinds (strategy, content_brief, content_copy,
 *     outreach_drafts, report, audit) ship Markdown.
 *   • Diagnostic kinds (technical_crawl) ship JSON — the row is just
 *     a pointer to the full crawl viewer.
 *
 * Each exporter is defensive: when the saved payload only carries
 * metadata (which is true for most jobs today — the full content lives
 * in the linked viewer page), the exporter renders a short metadata
 * summary instead of empty content.
 */

export type ExportFormat = "csv" | "md" | "json"

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

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

function fmtUsd(n: number | undefined): string {
  return n == null ? "—" : `$${n.toFixed(2)}`
}

function fmtDate(s: string | undefined): string {
  if (!s) return "—"
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString()
}

// ── JSON (universal fallback) ──────────────────────────────────────────────

function jsonExport(artifact: PartnerArtifact): ArtifactExport {
  return {
    format: "json",
    label: "Download JSON",
    filename: safeFilename(artifact.title, "json"),
    mimeType: "application/json",
    build: () => JSON.stringify(artifact.data, null, 2),
  }
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

// ── Tabular: faq_research / backlink_prospects / competitive_analysis ──────
//
// These kinds don't have wired-in writers yet — the exporter inspects the
// payload defensively, picks an `items` / `rows` / `prospects` field if one
// looks like an array of objects, and emits the union of keys as columns.
// As specific writers register their own shapes, swap these out for
// purpose-built generators.

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
  // Otherwise: if the top-level value IS an array of objects, use it.
  return []
}

// ── Markdown: narrative kinds ──────────────────────────────────────────────

function buildNarrativeMd(artifact: PartnerArtifact, kindLabel: string): string {
  const data = asObject(artifact.data)
  const lines: string[] = []
  lines.push(`# ${artifact.title}`)
  lines.push("")
  lines.push(`**Kind:** ${kindLabel}`)
  lines.push(`**Saved:** ${fmtDate(artifact.createdAt)}`)
  if (artifact.jobId) {
    lines.push(`**Source job:** \`${artifact.jobId}\``)
  }
  lines.push("")

  // Surface common narrative fields first when present.
  const narrative =
    asString(data.markdown) ??
    asString(data.body) ??
    asString(data.content) ??
    asString(data.text)
  if (narrative) {
    lines.push("---")
    lines.push("")
    lines.push(narrative)
    lines.push("")
    return lines.join("\n")
  }

  // Otherwise dump a "what we know" block from metadata-like fields.
  const skip = new Set(["markdown", "body", "content", "text"])
  const fields = Object.entries(data).filter(
    ([k, v]) =>
      !skip.has(k) &&
      (typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean"),
  )
  if (fields.length > 0) {
    lines.push("## Summary")
    lines.push("")
    for (const [k, v] of fields) {
      const formatted =
        k.toLowerCase().includes("cost") && typeof v === "number"
          ? fmtUsd(v)
          : k.toLowerCase().endsWith("at") && typeof v === "string"
            ? fmtDate(v)
            : String(v)
      lines.push(`- **${k}:** ${formatted}`)
    }
    lines.push("")
  }

  // Warnings array, if any (audit task writes this).
  const warnings = asArray(data.warnings).filter(
    (w): w is string => typeof w === "string",
  )
  if (warnings.length > 0) {
    lines.push("## Warnings")
    lines.push("")
    for (const w of warnings) lines.push(`- ${w}`)
    lines.push("")
  }

  if (lines.length <= 5) {
    lines.push("_(No further content saved — open the full result for details.)_")
  }
  return lines.join("\n")
}

// ── Diagnostic: technical_crawl ────────────────────────────────────────────

function buildTechnicalCrawlMd(artifact: PartnerArtifact): string {
  const data = asObject(artifact.data)
  const crawlId = asString(data.crawlId)
  const domain = asString(data.domain)
  const finishedAt = asString(data.finishedAt)
  const durationSeconds = asNumber(data.durationSeconds)
  const costUsd = asNumber(data.costUsd)
  const lines = [
    `# ${artifact.title}`,
    "",
    `**Domain:** ${domain ?? "—"}`,
    `**Finished:** ${fmtDate(finishedAt)}`,
    `**Duration:** ${durationSeconds != null ? `${durationSeconds}s` : "—"}`,
    `**Cost:** ${fmtUsd(costUsd)}`,
    "",
  ]
  if (crawlId) {
    lines.push(`Full crawl: \`/scheduled-tasks/runs/${crawlId}\``)
  }
  return lines.join("\n")
}

// ── Kind → labels ─────────────────────────────────────────────────────────

const KIND_LABEL: Record<PartnerArtifactKind, string> = {
  keyword_list: "Keyword list",
  keyword_overview: "Keyword overview",
  faq_research: "FAQ research",
  strategy: "Strategy",
  content_brief: "Content brief",
  content_copy: "Content copy",
  backlink_prospects: "Backlink prospects",
  backlinks_overview: "Backlinks overview",
  referring_domains: "Referring domains",
  backlink_trends: "Backlink trends",
  outreach_drafts: "Outreach drafts",
  report: "Report",
  technical_crawl: "Technical crawl",
  onpage_audit: "On-page audit",
  lighthouse_audit: "Lighthouse audit",
  competitive_analysis: "Competitive analysis",
  organic_rankings: "Organic rankings",
  domain_overview: "Domain overview",
  gbp_heatmap: "GBP heatmap",
  ai_snapshot: "AI snapshot",
  audit: "Audit",
}

// ── Public: per-artifact export list ───────────────────────────────────────

export function getArtifactExports(
  artifact: PartnerArtifact,
): ArtifactExport[] {
  const kindLabel = KIND_LABEL[artifact.kind] ?? artifact.kind
  const json = jsonExport(artifact)

  switch (artifact.kind) {
    case "keyword_list": {
      return [
        {
          format: "csv",
          label: "Download CSV",
          filename: safeFilename(artifact.title, "csv"),
          mimeType: "text/csv;charset=utf-8",
          build: () => buildKeywordListCsv(artifact),
        },
        json,
      ]
    }

    case "faq_research":
    case "backlink_prospects":
    case "referring_domains":
    case "backlink_trends":
    case "competitive_analysis":
    case "organic_rankings": {
      const rows = pickRowArray(asObject(artifact.data))
      const exports: ArtifactExport[] = []
      if (rows.length > 0) {
        exports.push({
          format: "csv",
          label: "Download CSV",
          filename: safeFilename(artifact.title, "csv"),
          mimeType: "text/csv;charset=utf-8",
          build: () => genericRowsCsv(rows),
        })
      }
      exports.push(json)
      return exports
    }

    case "strategy":
    case "content_brief":
    case "content_copy":
    case "outreach_drafts":
    case "report":
    case "audit":
    case "keyword_overview":
    case "backlinks_overview":
    case "domain_overview":
    case "onpage_audit":
    case "lighthouse_audit": {
      return [
        {
          format: "md",
          label: "Download Markdown",
          filename: safeFilename(artifact.title, "md"),
          mimeType: "text/markdown;charset=utf-8",
          build: () => buildNarrativeMd(artifact, kindLabel),
        },
        json,
      ]
    }

    case "technical_crawl": {
      return [
        {
          format: "md",
          label: "Download Markdown",
          filename: safeFilename(artifact.title, "md"),
          mimeType: "text/markdown;charset=utf-8",
          build: () => buildTechnicalCrawlMd(artifact),
        },
        json,
      ]
    }

    case "gbp_heatmap":
    case "ai_snapshot": {
      // Dashboard snapshots: structured JSON is the canonical artifact;
      // a rough MD summary helps for pasting into reports.
      return [
        {
          format: "md",
          label: "Download Markdown",
          filename: safeFilename(artifact.title, "md"),
          mimeType: "text/markdown;charset=utf-8",
          build: () => buildNarrativeMd(artifact, kindLabel),
        },
        json,
      ]
    }

    default: {
      return [json]
    }
  }
}
