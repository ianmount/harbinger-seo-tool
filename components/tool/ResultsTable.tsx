"use client"

import { useMemo, useState } from "react"
import { Download, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { buildRowsWorkbook, downloadWorkbook } from "@/lib/tool-xlsx"
import type { XlsxColumnSpec } from "@/lib/tool-xlsx"
import { cn } from "@/lib/utils"

export type ResultColumn<T> = {
  key: string
  label: string
  numeric?: boolean
  /** Returns the value used for sort + xlsx export. */
  accessor: (row: T) => string | number | null | undefined
  /** Optional display formatter. Defaults to String(accessor()) or "". */
  format?: (row: T) => React.ReactNode
  /** Excel column width override. */
  xlsxWidth?: number
  /** Excel numFmt override. */
  xlsxNumFmt?: string
  /** Tailwind class for the cell. */
  cellClassName?: string
}

type SortDir = "asc" | "desc"

export function ResultsTable<T>({
  rows,
  columns,
  filename,
  caption,
  emptyMessage = "No results yet. Run the tool above to populate this table.",
  maxRows = 500,
}: {
  rows: readonly T[]
  columns: readonly ResultColumn<T>[]
  filename: string
  caption?: string
  emptyMessage?: string
  /** Hard cap on visible rows. DFSEO endpoints already limit responses; this
   *  is a safety net. Export always reflects the full filtered set. */
  maxRows?: number
}) {
  const [filter, setFilter] = useState("")
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<SortDir>("asc")

  const filteredRows = useMemo(() => {
    if (!filter.trim()) return rows
    const needle = filter.trim().toLowerCase()
    return rows.filter((row) =>
      columns.some((c) => {
        const v = c.accessor(row)
        return v != null && String(v).toLowerCase().includes(needle)
      }),
    )
  }, [rows, columns, filter])

  const sortedRows = useMemo(() => {
    if (!sortKey) return filteredRows
    const col = columns.find((c) => c.key === sortKey)
    if (!col) return filteredRows
    const copy = [...filteredRows]
    copy.sort((a, b) => {
      const av = col.accessor(a)
      const bv = col.accessor(b)
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === "number" && typeof bv === "number") {
        return sortDir === "asc" ? av - bv : bv - av
      }
      const cmp = String(av).localeCompare(String(bv), undefined, {
        numeric: true,
      })
      return sortDir === "asc" ? cmp : -cmp
    })
    return copy
  }, [filteredRows, sortKey, sortDir, columns])

  const handleHeaderClick = (key: string) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortKey(key)
      setSortDir("asc")
    }
  }

  const handleExport = async () => {
    const xlsxColumns: XlsxColumnSpec<T>[] = columns.map((c) => ({
      label: c.label,
      width: c.xlsxWidth,
      numeric: c.numeric,
      numFmt: c.xlsxNumFmt,
      value: c.accessor,
    }))
    const wb = buildRowsWorkbook(sortedRows, xlsxColumns, "Results")
    const safeName = filename.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase()
    await downloadWorkbook(wb, `${safeName}-${Date.now()}.xlsx`)
  }

  const visibleRows = sortedRows.slice(0, maxRows)

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line bg-muted/30 px-6 py-10 text-center">
        <p className="font-serif text-[13.5px] text-ink-3">{emptyMessage}</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-[360px]">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-ink-3" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter results…"
            className="pl-8"
          />
        </div>
        <div className="flex-1" />
        <span className="font-mono text-[11px] text-ink-3">
          {filter.trim() || sortKey
            ? `${sortedRows.length.toLocaleString()} of ${rows.length.toLocaleString()}`
            : `${rows.length.toLocaleString()} rows`}
          {visibleRows.length < sortedRows.length
            ? ` · showing first ${maxRows.toLocaleString()}`
            : ""}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleExport}
          className="h-9"
        >
          <Download className="mr-1.5 h-3.5 w-3.5" />
          Export XLSX
        </Button>
      </div>

      <div className="overflow-hidden rounded-lg border border-line">
        <Table>
          {caption ? <caption className="sr-only">{caption}</caption> : null}
          <TableHeader>
            <TableRow>
              {columns.map((c) => {
                const active = sortKey === c.key
                return (
                  <TableHead
                    key={c.key}
                    className={cn(
                      "cursor-pointer select-none",
                      c.numeric ? "text-right" : "",
                      active ? "text-foreground" : "",
                    )}
                    onClick={() => handleHeaderClick(c.key)}
                  >
                    <span className="inline-flex items-center gap-1">
                      {c.label}
                      {active ? (
                        <span aria-hidden className="text-[9px]">
                          {sortDir === "asc" ? "▲" : "▼"}
                        </span>
                      ) : null}
                    </span>
                  </TableHead>
                )
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleRows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="px-3.5 py-6 text-center text-ink-3"
                >
                  No rows match &ldquo;{filter}&rdquo;.
                </TableCell>
              </TableRow>
            ) : (
              visibleRows.map((row, i) => (
                <TableRow key={i}>
                  {columns.map((c) => {
                    const display =
                      c.format != null
                        ? c.format(row)
                        : (() => {
                            const v = c.accessor(row)
                            return v == null ? "" : String(v)
                          })()
                    return (
                      <TableCell
                        key={c.key}
                        className={cn(
                          c.numeric ? "num" : "",
                          c.cellClassName,
                        )}
                      >
                        {display}
                      </TableCell>
                    )
                  })}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
