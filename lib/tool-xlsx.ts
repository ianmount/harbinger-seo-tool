/**
 * Generic xlsx exporter for tool result tables.
 *
 * Used by `components/tool/ResultsTable.tsx`. Lives outside that component
 * so it can be unit-tested and reused by any tool that wants to dump a
 * row[] to a single-sheet workbook with frozen header + autofilter.
 */

import ExcelJS from "exceljs"

export type XlsxColumnSpec<T> = {
  /** Column header. */
  label: string
  /** Excel column width (in character units). Default 18. */
  width?: number
  /** Right-align + tabular-nums style. Use for numeric columns. */
  numeric?: boolean
  /** Excel number format string (e.g. "0.00%"). */
  numFmt?: string
  /** Cell value extractor. Return a primitive — string | number | null. */
  value: (row: T) => string | number | null | undefined
}

const HEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF1F2A44" },
}

const HEADER_FONT: Partial<ExcelJS.Font> = {
  bold: true,
  color: { argb: "FFFFFFFF" },
  size: 11,
}

export function buildRowsWorkbook<T>(
  rows: readonly T[],
  columns: readonly XlsxColumnSpec<T>[],
  sheetName: string,
): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook()
  wb.creator = "Harbinger SEO Tool"
  wb.created = new Date()

  const ws = wb.addWorksheet(sheetName.slice(0, 31) || "Results")
  ws.columns = columns.map((col, i) => ({
    header: col.label,
    key: `c${i}`,
    width: col.width ?? 18,
    style: col.numFmt ? { numFmt: col.numFmt } : undefined,
  }))

  ws.getRow(1).eachCell((cell) => {
    cell.font = HEADER_FONT
    cell.fill = HEADER_FILL
    cell.alignment = { vertical: "middle", horizontal: "left" }
  })
  ws.getRow(1).height = 22

  for (const row of rows) {
    const entry: Record<string, string | number | null> = {}
    columns.forEach((col, i) => {
      const raw = col.value(row)
      entry[`c${i}`] = raw == null ? null : raw
    })
    ws.addRow(entry)
  }

  columns.forEach((col, i) => {
    if (col.numeric) {
      ws.getColumn(i + 1).alignment = { horizontal: "right" }
    }
  })

  ws.views = [{ state: "frozen", ySplit: 1 }]
  if (columns.length > 0) {
    const lastCol = ws.getColumn(columns.length).letter
    ws.autoFilter = `A1:${lastCol}1`
  }

  return wb
}

/** Trigger a browser download for a Workbook built from `buildRowsWorkbook`. */
export async function downloadWorkbook(
  wb: ExcelJS.Workbook,
  filename: string,
): Promise<void> {
  const buf = await wb.xlsx.writeBuffer()
  const blob = new Blob([buf as ArrayBuffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename.endsWith(".xlsx") ? filename : `${filename}.xlsx`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
