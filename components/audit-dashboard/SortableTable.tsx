"use client"

import { useMemo, useState, type ReactNode } from "react"
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react"
import { cn } from "@/lib/utils"

export type SortDir = "asc" | "desc"

export interface ColumnDef<T> {
  key: string
  header: string
  /** Return the cell content for display. */
  cell: (row: T) => ReactNode
  /** Return the sort key. Numbers sort numerically; strings lexicographically. */
  sortBy?: (row: T) => number | string
  align?: "left" | "right"
  /** Tailwind width hint, e.g. `w-[220px]`. */
  width?: string
}

interface Props<T> {
  rows: T[]
  columns: ColumnDef<T>[]
  initialSortKey?: string
  initialSortDir?: SortDir
  /** Optional substring filter — calls `filterAccessor(row)` to test. */
  filterAccessor?: (row: T) => string
  filterPlaceholder?: string
  emptyMessage?: string
  /** Caption above the table, optional. */
  caption?: ReactNode
}

export function SortableTable<T>({
  rows,
  columns,
  initialSortKey,
  initialSortDir = "desc",
  filterAccessor,
  filterPlaceholder,
  emptyMessage = "No rows.",
  caption,
}: Props<T>) {
  const [sortKey, setSortKey] = useState<string | undefined>(initialSortKey)
  const [sortDir, setSortDir] = useState<SortDir>(initialSortDir)
  const [filter, setFilter] = useState<string>("")

  const filtered = useMemo(() => {
    if (!filterAccessor || filter.trim().length === 0) return rows
    const q = filter.toLowerCase()
    return rows.filter((r) => filterAccessor(r).toLowerCase().includes(q))
  }, [rows, filter, filterAccessor])

  const sorted = useMemo(() => {
    if (!sortKey) return filtered
    const col = columns.find((c) => c.key === sortKey)
    if (!col?.sortBy) return filtered
    const dir = sortDir === "asc" ? 1 : -1
    return [...filtered].sort((a, b) => {
      const av = col.sortBy!(a)
      const bv = col.sortBy!(b)
      if (typeof av === "number" && typeof bv === "number") {
        return (av - bv) * dir
      }
      return String(av).localeCompare(String(bv)) * dir
    })
  }, [filtered, sortKey, sortDir, columns])

  function toggleSort(key: string) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortKey(key)
      setSortDir("desc")
    }
  }

  return (
    <div className="space-y-3">
      {caption ? (
        <p className="font-serif text-[13.5px] italic text-ink-2">{caption}</p>
      ) : null}
      {filterAccessor ? (
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={filterPlaceholder ?? "Filter…"}
          data-print-hide
          className="w-full max-w-[360px] rounded-[10px] border border-line bg-background px-3 py-2 font-serif text-[13.5px] text-foreground placeholder:text-ink-3 focus:border-brand-red focus:outline-none focus:ring-2 focus:ring-brand-red/30"
        />
      ) : null}
      <div className="overflow-x-auto rounded-[10px] border border-line">
        <table className="w-full border-collapse text-left">
          <thead className="bg-brand-paper">
            <tr>
              {columns.map((col) => {
                const active = sortKey === col.key
                const sortable = !!col.sortBy
                return (
                  <th
                    key={col.key}
                    scope="col"
                    className={cn(
                      "border-b border-line px-3 py-2.5 font-sans text-[10.5px] font-bold uppercase tracking-[0.16em] text-ink-2",
                      col.align === "right" && "text-right",
                      col.width,
                    )}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(col.key)}
                        data-print-hide
                        className={cn(
                          "inline-flex items-center gap-1.5 transition-colors hover:text-foreground",
                          active && "text-foreground",
                        )}
                      >
                        <span>{col.header}</span>
                        {active ? (
                          sortDir === "asc" ? (
                            <ArrowUp className="h-3 w-3" aria-hidden />
                          ) : (
                            <ArrowDown className="h-3 w-3" aria-hidden />
                          )
                        ) : (
                          <ArrowUpDown className="h-3 w-3 opacity-60" aria-hidden />
                        )}
                      </button>
                    ) : (
                      col.header
                    )}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-3 py-6 text-center font-serif text-[13.5px] italic text-ink-3"
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              sorted.map((row, i) => (
                <tr
                  key={i}
                  className="border-b border-line/70 last:border-b-0 odd:bg-card even:bg-brand-paper/40"
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={cn(
                        "px-3 py-2.5 font-serif text-[13.5px] text-foreground",
                        col.align === "right" &&
                          "text-right font-sans font-semibold tabular-nums",
                      )}
                    >
                      {col.cell(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {filterAccessor && filter ? (
        <p className="font-serif text-xs italic text-ink-3">
          {sorted.length} of {rows.length} rows match.
        </p>
      ) : null}
    </div>
  )
}
