"use client"

import { useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

/**
 * Renderer for a saved `keyword_list` artifact. The payload was written
 * by `/keywords/magic`'s SaveToPartnerButton with this shape:
 *
 *   {
 *     seed: string
 *     markets: Array<{ key, label, location_code, location_name }>
 *     stats: { total, avg_volume, avg_kd }
 *     counts: { all, phrase, related, pasf, questions }
 *     selectedKeywords: MagicRow[] | null   // if user had selections
 *     rows: MagicRow[]                       // full result set
 *     capturedAt: string
 *   }
 *
 * We don't import the full MagicRow type here because the canonical
 * source is the route module (`app/keywords/magic/page.tsx`); instead
 * we narrowly type the columns we render and tolerate missing fields
 * from older payload shapes.
 */

interface KeywordRow {
  keyword: string
  search_volume?: number
  keyword_difficulty?: number
  cpc?: number
  competition_level?: string
  intent?: string
  sources?: Array<string>
}

interface KeywordListData {
  seed?: string
  capturedAt?: string
  stats?: {
    total?: number
    avg_volume?: number | null
    avg_kd?: number | null
  }
  counts?: Record<string, number>
  markets?: Array<{ label?: string; location_name?: string; key?: string }>
  selectedKeywords?: KeywordRow[] | null
  rows?: KeywordRow[]
}

const PAGE_SIZE = 50

function isKeywordRow(v: unknown): v is KeywordRow {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Record<string, unknown>).keyword === "string"
  )
}

function asKeywordList(data: unknown): KeywordListData {
  if (typeof data !== "object" || data === null) return {}
  const obj = data as Record<string, unknown>
  return {
    seed: typeof obj.seed === "string" ? obj.seed : undefined,
    capturedAt: typeof obj.capturedAt === "string" ? obj.capturedAt : undefined,
    stats:
      typeof obj.stats === "object" && obj.stats !== null
        ? (obj.stats as KeywordListData["stats"])
        : undefined,
    counts:
      typeof obj.counts === "object" && obj.counts !== null
        ? (obj.counts as Record<string, number>)
        : undefined,
    markets: Array.isArray(obj.markets)
      ? (obj.markets as KeywordListData["markets"])
      : undefined,
    selectedKeywords: Array.isArray(obj.selectedKeywords)
      ? (obj.selectedKeywords as unknown[]).filter(isKeywordRow)
      : null,
    rows: Array.isArray(obj.rows)
      ? (obj.rows as unknown[]).filter(isKeywordRow)
      : [],
  }
}

function fmtNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  return n.toLocaleString()
}

export function KeywordListView({ data }: { data: unknown }) {
  const parsed = useMemo(() => asKeywordList(data), [data])
  const [page, setPage] = useState(0)
  const [query, setQuery] = useState("")
  const [viewMode, setViewMode] = useState<"selected" | "all">(
    parsed.selectedKeywords && parsed.selectedKeywords.length > 0
      ? "selected"
      : "all",
  )

  const sourceRows =
    viewMode === "selected"
      ? parsed.selectedKeywords ?? parsed.rows ?? []
      : parsed.rows ?? []

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return sourceRows
    return sourceRows.filter((r) => r.keyword.toLowerCase().includes(q))
  }, [sourceRows, query])

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages - 1)
  const pageRows = filteredRows.slice(
    safePage * PAGE_SIZE,
    (safePage + 1) * PAGE_SIZE,
  )

  return (
    <div className="space-y-5">
      {parsed.seed && (
        <div className="rounded-lg border border-border p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Seed
          </p>
          <p className="mt-1 font-mono text-sm">{parsed.seed}</p>
          {parsed.markets && parsed.markets.length > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              Markets:{" "}
              {parsed.markets
                .map((m) => m.label ?? m.location_name ?? m.key ?? "—")
                .join(" · ")}
            </p>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Total" value={fmtNumber(parsed.stats?.total)} />
        <Stat
          label="Avg volume"
          value={fmtNumber(parsed.stats?.avg_volume ?? null)}
        />
        <Stat label="Avg KD" value={fmtNumber(parsed.stats?.avg_kd ?? null)} />
        <Stat
          label="Selected"
          value={fmtNumber(parsed.selectedKeywords?.length ?? 0)}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {parsed.selectedKeywords && parsed.selectedKeywords.length > 0 && (
            <>
              <Button
                type="button"
                variant={viewMode === "selected" ? "secondary" : "outline"}
                size="sm"
                onClick={() => {
                  setViewMode("selected")
                  setPage(0)
                }}
              >
                Selected ({parsed.selectedKeywords.length})
              </Button>
              <Button
                type="button"
                variant={viewMode === "all" ? "secondary" : "outline"}
                size="sm"
                onClick={() => {
                  setViewMode("all")
                  setPage(0)
                }}
              >
                All ({parsed.rows?.length ?? 0})
              </Button>
            </>
          )}
        </div>
        <Input
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setPage(0)
          }}
          placeholder="Filter keywords…"
          className="h-9 w-[240px]"
          aria-label="Filter keywords"
        />
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-muted/50 text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Keyword</th>
              <th className="px-3 py-2 text-right font-medium">Volume</th>
              <th className="px-3 py-2 text-right font-medium">KD</th>
              <th className="px-3 py-2 text-right font-medium">CPC</th>
              <th className="px-3 py-2 font-medium">Intent</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-3 py-6 text-center text-sm text-muted-foreground"
                >
                  No keywords match.
                </td>
              </tr>
            ) : (
              pageRows.map((row, i) => (
                <tr
                  key={`${row.keyword}-${i}`}
                  className="border-b border-border last:border-b-0"
                >
                  <td className="px-3 py-2 font-mono text-xs">{row.keyword}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {fmtNumber(row.search_volume)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {row.keyword_difficulty ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {row.cpc != null ? `$${row.cpc.toFixed(2)}` : "—"}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {row.intent ?? row.competition_level ?? "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {filteredRows.length === 0
            ? "0 of 0"
            : `${(safePage * PAGE_SIZE + 1).toLocaleString()}–${Math.min(
                (safePage + 1) * PAGE_SIZE,
                filteredRows.length,
              ).toLocaleString()} of ${filteredRows.length.toLocaleString()}`}
        </span>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={safePage === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            Prev
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={safePage >= totalPages - 1}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  )
}
