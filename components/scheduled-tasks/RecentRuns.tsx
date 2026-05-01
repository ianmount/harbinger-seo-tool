"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { RecentRun, TaskKind } from "./types"

const KIND_LABELS: Record<TaskKind, string> = {
  technical_crawl: "Technical Crawl",
  full_audit: "Full Audit",
}

function formatDate(iso: string | null): string {
  if (!iso) return "—"
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

function statusVariant(
  status: RecentRun["status"],
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "completed") return "secondary"
  if (status === "failed" || status === "cancelled") return "destructive"
  return "default"
}

/**
 * Combined "Recent runs" list at the bottom of the Scheduled Tasks page.
 * Surfaces both kinds — technical_crawl and full_audit — so the user can
 * spot trouble across the whole pipeline at a glance.
 *
 * Auto-refreshes every 30s while any in-flight runs exist; otherwise idle.
 */
export function RecentRuns() {
  const [runs, setRuns] = useState<RecentRun[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(0)

  const pageSize = 5
  const totalPages = Math.max(1, Math.ceil(runs.length / pageSize))
  const safePage = useMemo(
    () => Math.min(page, totalPages - 1),
    [page, totalPages],
  )
  const visibleRuns = useMemo(
    () => runs.slice(safePage * pageSize, safePage * pageSize + pageSize),
    [runs, safePage],
  )
  const rangeStart = runs.length === 0 ? 0 : safePage * pageSize + 1
  const rangeEnd = Math.min(runs.length, safePage * pageSize + pageSize)

  async function reload() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/scheduled-tasks/recent-runs", {
        cache: "no-store",
      })
      const body = (await res.json()) as { runs?: RecentRun[]; error?: string }
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      setRuns(body.runs ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load runs")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reload()
  }, [])

  // Poll while anything in-flight; otherwise idle.
  useEffect(() => {
    if (
      !runs.some((r) => r.status === "queued" || r.status === "running")
    )
      return
    const t = setInterval(reload, 30_000)
    return () => clearInterval(t)
  }, [runs])

  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="font-sans text-sm font-extrabold uppercase tracking-[0.18em] text-muted-foreground">
            Recent runs
          </h2>
          <p className="mt-1 font-serif text-[14px] text-ink-2">
            Last 50 scheduled-task runs across both task types.
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={reload} disabled={loading}>
          Refresh
        </Button>
      </div>

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : loading && runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : runs.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
          No runs yet.
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Task</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Attention</TableHead>
                <TableHead className="text-right">Status</TableHead>
                <TableHead className="text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleRuns.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="text-xs">
                    <div>{formatDate(r.created_at)}</div>
                    {r.completed_at && r.completed_at !== r.created_at ? (
                      <div className="text-muted-foreground">
                        done {formatDate(r.completed_at)}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>{KIND_LABELS[r.kind]}</TableCell>
                  <TableCell className="max-w-[280px] truncate" title={r.title}>
                    {r.title}
                  </TableCell>
                  <TableCell>
                    {r.needs_attention ? (
                      <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-700">
                        {r.attention_summary?.severity ?? "flagged"}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button asChild size="sm" variant="ghost">
                      <Link href={r.result_path ?? `/jobs/${r.id}`}>View</Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {runs.length > pageSize ? (
            <div className="flex items-center justify-between border-t border-border bg-muted/20 px-4 py-2 text-xs text-muted-foreground">
              <span className="tabular-nums">
                Showing {rangeStart}–{rangeEnd} of {runs.length}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={safePage === 0}
                  aria-label="Previous page"
                >
                  <ChevronLeft className="h-4 w-4" />
                  Prev
                </Button>
                <span className="px-2 tabular-nums">
                  Page {safePage + 1} of {totalPages}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setPage((p) => Math.min(totalPages - 1, p + 1))
                  }
                  disabled={safePage >= totalPages - 1}
                  aria-label="Next page"
                >
                  Next
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </section>
  )
}
