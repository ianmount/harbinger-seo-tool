import ExcelJS from "exceljs"
import type {
  ContentCarryover,
  InitialStrategyOutput,
  KeywordMapping,
  UrlMapping,
  InternalLink,
} from "@/lib/types"

/**
 * Builds the three-sheet Initial Strategy workbook (Keyword Mapping, URL
 * Mapping, Internal Linking) from a parsed `InitialStrategyOutput`. Returns
 * the workbook so callers can serialize to either a Node Buffer
 * (`workbook.xlsx.writeBuffer()`) or stream it directly.
 *
 * Designed to run in either a Node route handler or the browser — avoid
 * importing anything Node-only from this module (no fs, no `server-only`).
 *
 * Sheet layout matches the columns the SEO engineer + downstream developer
 * have asked for: tight, no metadata noise. Wide-text columns (rationale,
 * notes) sit at the right so the engineer can hide them when sharing.
 */
export function buildInitialStrategyWorkbook(
  data: InitialStrategyOutput,
): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook()
  wb.creator = "Harbinger SEO Tool"
  wb.created = new Date(data.generatedAt)

  buildKeywordSheet(wb.addWorksheet("Keyword Mapping"), data.keywordMapping)
  buildUrlSheet(wb.addWorksheet("URL Mapping"), data.urlMapping)
  buildLinkingSheet(wb.addWorksheet("Internal Linking"), data.internalLinking)
  buildCarryoverSheet(
    wb.addWorksheet("Content Carryover"),
    data.contentCarryover,
  )

  return wb
}

/** Returns an ArrayBuffer suitable for `new Blob([buf])` in the browser. */
export async function workbookToArrayBuffer(
  wb: ExcelJS.Workbook,
): Promise<ArrayBuffer> {
  // ExcelJS' Node typing claims Buffer; in the browser bundle it's an
  // ArrayBuffer. Either way `new Blob([result])` accepts both.
  const result = await wb.xlsx.writeBuffer()
  return result as ArrayBuffer
}

const HEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF1F2A44" }, // Harbinger navy-ish, dark enough for white text.
}
const HEADER_FONT: Partial<ExcelJS.Font> = {
  bold: true,
  color: { argb: "FFFFFFFF" },
  size: 11,
}

function applyHeaderRowStyle(row: ExcelJS.Row): void {
  row.eachCell((cell) => {
    cell.font = HEADER_FONT
    cell.fill = HEADER_FILL
    cell.alignment = { vertical: "middle", horizontal: "left" }
    cell.border = {
      bottom: { style: "thin", color: { argb: "FF1F2A44" } },
    }
  })
  row.height = 22
}

function freezeHeaderAndAutoFilter(
  ws: ExcelJS.Worksheet,
  columnCount: number,
): void {
  ws.views = [{ state: "frozen", ySplit: 1 }]
  // ExcelJS columns are 1-indexed; convert the last column to its A1 letter.
  const lastCol = ws.getColumn(columnCount).letter
  ws.autoFilter = `A1:${lastCol}1`
}

function buildKeywordSheet(
  ws: ExcelJS.Worksheet,
  rows: KeywordMapping[],
): void {
  ws.columns = [
    { header: "Page", key: "pageName", width: 28 },
    { header: "New URL", key: "newUrl", width: 38 },
    { header: "Primary Keyword", key: "primary", width: 28 },
    { header: "Secondary Keywords", key: "secondary", width: 50 },
    { header: "Rationale", key: "rationale", width: 60 },
  ]
  applyHeaderRowStyle(ws.getRow(1))

  for (const row of rows) {
    ws.addRow({
      pageName: row.pagePath || row.pageName,
      newUrl: row.newUrl,
      primary: row.primaryKeyword,
      secondary: row.secondaryKeywords.join(", "),
      rationale: row.rationale,
    })
  }
  // Wrap long-text columns so the engineer can read rationales without
  // resizing the column manually.
  ws.getColumn("secondary").alignment = { wrapText: true, vertical: "top" }
  ws.getColumn("rationale").alignment = { wrapText: true, vertical: "top" }
  freezeHeaderAndAutoFilter(ws, ws.columnCount)
}

function buildUrlSheet(ws: ExcelJS.Worksheet, rows: UrlMapping[]): void {
  ws.columns = [
    { header: "Old URL", key: "oldUrl", width: 50 },
    { header: "New URL", key: "newUrl", width: 50 },
    { header: "Redirect Type", key: "redirectType", width: 14 },
    { header: "Notes", key: "notes", width: 60 },
  ]
  applyHeaderRowStyle(ws.getRow(1))

  for (const row of rows) {
    ws.addRow({
      oldUrl: row.oldUrl,
      newUrl: row.newUrl ?? "",
      redirectType: row.redirectType,
      notes: row.notes,
    })
  }
  ws.getColumn("notes").alignment = { wrapText: true, vertical: "top" }
  // Highlight rows where redirectType === "none" so they're easy to spot
  // (these are the URLs being retired with no redirect target).
  for (let r = 2; r <= ws.rowCount; r++) {
    const typeCell = ws.getCell(r, 3)
    if (typeCell.value === "none") {
      ws.getRow(r).eachCell((cell) => {
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFFFF1E6" }, // soft amber tint
        }
      })
    }
  }
  freezeHeaderAndAutoFilter(ws, ws.columnCount)
}

const CARRYOVER_RECOMMENDATION_LABEL: Record<
  ContentCarryover["recommendation"],
  string
> = {
  "port-as-is": "Port as-is",
  "port-and-refresh": "Port & refresh",
  rewrite: "Rewrite",
  retire: "Retire",
}

function buildCarryoverSheet(
  ws: ExcelJS.Worksheet,
  rows: ContentCarryover[],
): void {
  ws.columns = [
    { header: "Old URL", key: "oldUrl", width: 50 },
    { header: "Recommendation", key: "recommendation", width: 18 },
    { header: "Target URL", key: "newUrl", width: 38 },
    { header: "Title", key: "title", width: 38 },
    { header: "Word Count", key: "wordCount", width: 12 },
    { header: "Clicks (180d)", key: "clicks", width: 14 },
    { header: "Impressions (180d)", key: "impressions", width: 18 },
    { header: "CTR (180d)", key: "ctr", width: 12 },
    { header: "Avg Position (180d)", key: "position", width: 18 },
    { header: "Source", key: "source", width: 12 },
    { header: "Rationale", key: "rationale", width: 60 },
  ]
  applyHeaderRowStyle(ws.getRow(1))

  for (const row of rows) {
    ws.addRow({
      oldUrl: row.oldUrl,
      recommendation: CARRYOVER_RECOMMENDATION_LABEL[row.recommendation],
      newUrl: row.newUrl ?? "",
      title: row.title,
      wordCount: row.wordCount,
      clicks: row.gsc ? row.gsc.clicks : "",
      impressions: row.gsc ? row.gsc.impressions : "",
      ctr: row.gsc ? row.gsc.ctr : "",
      position: row.gsc ? row.gsc.position : "",
      source: row.autoGenerated ? "auto" : "Claude",
      rationale: row.rationale,
    })
  }
  ws.getColumn("ctr").numFmt = "0.0%"
  ws.getColumn("position").numFmt = "0.0"
  ws.getColumn("rationale").alignment = { wrapText: true, vertical: "top" }
  ws.getColumn("title").alignment = { wrapText: true, vertical: "top" }

  // Tint retire rows amber so the engineer can spot them at a glance, the
  // same convention the URL Mapping sheet uses for redirectType=none.
  for (let r = 2; r <= ws.rowCount; r++) {
    const recCell = ws.getCell(r, 2)
    if (recCell.value === CARRYOVER_RECOMMENDATION_LABEL.retire) {
      ws.getRow(r).eachCell((cell) => {
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFFFF1E6" },
        }
      })
    }
  }
  freezeHeaderAndAutoFilter(ws, ws.columnCount)
}

function buildLinkingSheet(
  ws: ExcelJS.Worksheet,
  rows: InternalLink[],
): void {
  ws.columns = [
    { header: "Source Page", key: "source", width: 32 },
    { header: "Source URL", key: "sourceUrl", width: 38 },
    { header: "Target Page", key: "target", width: 32 },
    { header: "Target URL", key: "targetUrl", width: 38 },
    { header: "Anchor Text", key: "anchor", width: 32 },
    { header: "Rationale", key: "rationale", width: 60 },
  ]
  applyHeaderRowStyle(ws.getRow(1))

  for (const row of rows) {
    ws.addRow({
      source: row.sourcePath || row.sourcePage,
      sourceUrl: row.sourceUrl,
      target: row.targetPath || row.targetPage,
      targetUrl: row.targetUrl,
      anchor: row.anchorText,
      rationale: row.rationale,
    })
  }
  ws.getColumn("rationale").alignment = { wrapText: true, vertical: "top" }
  freezeHeaderAndAutoFilter(ws, ws.columnCount)
}
