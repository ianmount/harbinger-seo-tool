"use client"

import { useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { Partner } from "@/lib/types"
import { CrawlDetail } from "./CrawlDetail"
import type { CrawlRunListItem } from "./types"

const ALL_PARTNERS = "__all__"

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

function formatDuration(seconds: number | null): string {
  if (seconds == null) return "—"
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function statusBadgeVariant(
  status: CrawlRunListItem["status"],
): "default" | "secondary" | "destructive" {
  if (status === "done") return "secondary"
  if (status === "failed") return "destructive"
  return "default"
}

/**
 * History list + drill-down. Filters by partner (default = all), pages
 * top 50. Selecting a row swaps the right pane in to the full detail
 * fetched lazily by id. Auto-refreshes every 30s only when a "running"
 * row is in the current list — otherwise it's static and idle.
 */
export function HistoryPanel({
  selectedRunId,
  onSelectRun,
}: {
  selectedRunId: string | null
  onSelectRun: (id: string | null) => void
}) {
  const [partners, setPartners] = useState<Partner[]>([])
  const [filter, setFilter] = useState<string>(ALL_PARTNERS)
  const [runs, setRuns] = useState<CrawlRunListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function reload() {
    setLoading(true)
    setError(null)
    try {
      const [partnersRes, runsRes] = await Promise.all([
        partners.length === 0
          ? fetch("/api/airtable/partners")
          : Promise.resolve(null),
        fetch(buildListUrl(filter)),
      ])
      if (partnersRes) {
        const partnersBody = (await partnersRes.json()) as {
          partners?: Partner[]
          error?: string
        }
        if (!partnersRes.ok) throw new Error(partnersBody.error ?? `HTTP ${partnersRes.status}`)
        setPartners(
          (partnersBody.partners ?? [])
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name)),
        )
      }
      const runsBody = (await runsRes.json()) as {
        runs?: CrawlRunListItem[]
        error?: string
      }
      if (!runsRes.ok) throw new Error(runsBody.error ?? `HTTP ${runsRes.status}`)
      setRuns(runsBody.runs ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load history")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter])

  // Auto-refresh while any row is "running" so the user sees the row flip
  // to "done" without manual reload.
  useEffect(() => {
    if (!runs.some((r) => r.status === "running")) return
    const t = setInterval(reload, 30_000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs])

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <section className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="hist-partner">Filter by partner</Label>
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger id="hist-partner">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_PARTNERS}>All</SelectItem>
              {partners.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {loading ? "Loading…" : `${runs.length} crawl${runs.length === 1 ? "" : "s"}`}
          </p>
          <Button size="sm" variant="ghost" onClick={reload} disabled={loading}>
            Refresh
          </Button>
        </div>
        {error ? (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
          >
            <p className="font-medium text-destructive">Failed to load history</p>
            <p className="mt-1 break-words text-muted-foreground">{error}</p>
            {/Invalid path|fetch failed|service_role|JWT/i.test(error) ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Looks like a Supabase config issue. Verify{" "}
                <code>SUPABASE_URL</code> (the &quot;Project URL&quot; — should
                end in <code>.supabase.co</code> with no path) and{" "}
                <code>SUPABASE_SERVICE_ROLE_KEY</code> in Vercel, then redeploy.
                Also confirm <code>supabase/schema.sql</code> ran in the SQL
                editor.
              </p>
            ) : null}
          </div>
        ) : runs.length === 0 && !loading ? (
          <p className="text-sm text-muted-foreground">No crawls yet.</p>
        ) : (
          <div className="overflow-hidden rounded-md border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead className="text-right">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((r) => (
                  <TableRow
                    key={r.id}
                    className={`cursor-pointer ${
                      selectedRunId === r.id ? "bg-muted/50" : ""
                    }`}
                    onClick={() => onSelectRun(r.id)}
                  >
                    <TableCell className="text-xs">
                      <div>{formatDate(r.started_at)}</div>
                      <div className="text-muted-foreground">
                        {formatDuration(r.duration_seconds)}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">
                        {r.partner_name ?? r.domain}
                      </div>
                      {r.partner_name ? (
                        <div className="text-xs text-muted-foreground">{r.domain}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge variant={statusBadgeVariant(r.status)}>{r.status}</Badge>
                      <div className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                        {r.source}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <section className="min-w-0">
        {selectedRunId ? (
          <CrawlDetail runId={selectedRunId} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Select a crawl on the left to view details.
          </p>
        )}
      </section>
    </div>
  )
}

function buildListUrl(filter: string): string {
  if (filter === ALL_PARTNERS) return "/api/technical-crawls/list"
  const params = new URLSearchParams({ partnerId: filter })
  return `/api/technical-crawls/list?${params.toString()}`
}
