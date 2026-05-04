"use client"

import { useCallback, useEffect, useState } from "react"
import type { DateRange } from "react-day-picker"
import { CalendarIcon, ExternalLinkIcon } from "lucide-react"
import { PerformanceChart } from "@/components/partner-dashboard/PerformanceChart"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"
import type {
  GA4SeoReport,
  GSCDailyRow,
  GSCTopPageRow,
  GSCTopQueryRow,
} from "@/lib/types"

interface Props {
  gscSiteUrl: string | null
  ga4PropertyId: string | null
}

type GscState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "done"
      topQueries: GSCTopQueryRow[]
      topPages: GSCTopPageRow[]
      dailyClicks: GSCDailyRow[]
    }

type Ga4State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "done"; report: GA4SeoReport }

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

function defaultRange(): DateRange {
  const to = new Date()
  const from = new Date()
  from.setDate(to.getDate() - 27)
  return { from, to }
}

function formatRange(range: DateRange | undefined): string {
  if (!range?.from) return "Pick a date range"
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
  if (!range.to) return fmt(range.from)
  return `${fmt(range.from)} – ${fmt(range.to)}`
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toLocaleString()
}

function fmtCtr(n: number): string {
  return `${(n * 100).toFixed(1)}%`
}

function fmtPos(n: number): string {
  return n.toFixed(1)
}

function MetricCard({
  label,
  value,
  sub,
}: {
  label: string
  value: string
  sub?: string
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 font-mono text-2xl font-semibold tabular-nums">
        {value}
      </p>
      {sub && <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  )
}

export function PartnerPerformancePanel({ gscSiteUrl, ga4PropertyId }: Props) {
  const [range, setRange] = useState<DateRange | undefined>(defaultRange)
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [gsc, setGsc] = useState<GscState>({ status: "idle" })
  const [ga4, setGa4] = useState<Ga4State>({ status: "idle" })

  const load = useCallback(
    async (r: DateRange) => {
      if (!r.from || !r.to) return
      const startDate = iso(r.from)
      const endDate = iso(r.to)

      // GSC
      if (gscSiteUrl) {
        setGsc({ status: "loading" })
        try {
          const res = await fetch("/api/gsc/report-data", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              siteUrl: gscSiteUrl,
              startDate,
              endDate,
              rowLimit: 1000,
            }),
          })
          const body = (await res.json()) as {
            topQueries?: GSCTopQueryRow[]
            topPages?: GSCTopPageRow[]
            dailyClicks?: GSCDailyRow[]
            error?: string
          }
          if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
          setGsc({
            status: "done",
            topQueries: body.topQueries ?? [],
            topPages: body.topPages ?? [],
            dailyClicks: body.dailyClicks ?? [],
          })
        } catch (err) {
          setGsc({
            status: "error",
            message: err instanceof Error ? err.message : "GSC fetch failed",
          })
        }
      }

      // GA4 (additive)
      if (ga4PropertyId) {
        setGa4({ status: "loading" })
        try {
          const res = await fetch("/api/ga4/report", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              propertyId: ga4PropertyId,
              startDate,
              endDate,
            }),
          })
          const body = (await res.json()) as GA4SeoReport | { error?: string }
          if (!res.ok || !("propertyId" in body)) {
            throw new Error(
              ("error" in body && body.error) || `HTTP ${res.status}`,
            )
          }
          setGa4({ status: "done", report: body })
        } catch (err) {
          setGa4({
            status: "error",
            message: err instanceof Error ? err.message : "GA4 fetch failed",
          })
        }
      }
    },
    [gscSiteUrl, ga4PropertyId],
  )

  useEffect(() => {
    if (range) load(range)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gscSiteUrl, ga4PropertyId])

  function handleRangeChange(r: DateRange | undefined) {
    setRange(r)
    if (r?.from && r?.to) load(r)
  }

  // Derived totals from dailyClicks
  let totals: {
    clicks: number
    impressions: number
    avgPosition: number | null
    avgCtr: number
  } | null = null
  if (gsc.status === "done") {
    let clicks = 0
    let impressions = 0
    let positionSum = 0
    for (const d of gsc.dailyClicks) {
      clicks += d.clicks
      impressions += d.impressions
      positionSum += d.position * d.impressions
    }
    totals = {
      clicks,
      impressions,
      avgPosition: impressions > 0 ? positionSum / impressions : null,
      avgCtr: impressions > 0 ? clicks / impressions : 0,
    }
  }

  // Indexing proxy: count of distinct pages with impressions / with clicks.
  // GSC topPages is sorted by clicks desc; we capped rowLimit at 1000 so this
  // is exact for sites with ≤1000 pages getting any visibility.
  let indexing: { pagesWithImpressions: number; pagesWithClicks: number } | null =
    null
  if (gsc.status === "done") {
    indexing = {
      pagesWithImpressions: gsc.topPages.length,
      pagesWithClicks: gsc.topPages.filter((p) => p.clicks > 0).length,
    }
  }

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="font-sans text-xs font-extrabold uppercase tracking-[0.18em] text-muted-foreground">
          Performance Detail
        </h2>
        <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className={cn(
                "h-8 w-[260px] justify-start text-left text-xs font-normal",
                !range?.from && "text-muted-foreground",
              )}
            >
              <CalendarIcon className="mr-2 size-3.5" />
              {formatRange(range)}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="end">
            <Calendar
              mode="range"
              selected={range}
              onSelect={(r) => {
                setPopoverOpen(false)
                handleRangeChange(r)
              }}
              numberOfMonths={2}
              defaultMonth={range?.from}
            />
          </PopoverContent>
        </Popover>
      </div>

      {/* GSC source ------------------------------------------------------- */}
      {!gscSiteUrl ? (
        <p className="text-sm text-muted-foreground">
          No GSC property matched this partner. Performance detail and report
          generation are unavailable until the SEO Ops Google account has
          access.
        </p>
      ) : gsc.status === "loading" || gsc.status === "idle" ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="h-24 animate-pulse rounded-lg border bg-muted/30"
              />
            ))}
          </div>
          <div className="h-64 animate-pulse rounded-lg border bg-muted/30" />
        </div>
      ) : gsc.status === "error" ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {gsc.message}
        </p>
      ) : (
        <>
          {/* Metric cards */}
          {totals && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <MetricCard label="Clicks" value={fmt(totals.clicks)} />
              <MetricCard
                label="Impressions"
                value={fmt(totals.impressions)}
              />
              <MetricCard
                label="Avg Position"
                value={
                  totals.avgPosition !== null
                    ? fmtPos(totals.avgPosition)
                    : "—"
                }
              />
              <MetricCard label="CTR" value={fmtCtr(totals.avgCtr)} />
            </div>
          )}

          {/* Performance chart */}
          <div className="space-y-2">
            <h3 className="font-sans text-xs font-extrabold uppercase tracking-[0.18em] text-muted-foreground">
              Daily Performance
            </h3>
            <PerformanceChart rows={gsc.dailyClicks} />
          </div>

          {/* Indexing */}
          {indexing && (
            <div className="space-y-2">
              <h3 className="font-sans text-xs font-extrabold uppercase tracking-[0.18em] text-muted-foreground">
                Indexing Snapshot
              </h3>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <MetricCard
                  label="Pages w/ Impressions"
                  value={fmt(indexing.pagesWithImpressions)}
                  sub={
                    indexing.pagesWithImpressions === 1000
                      ? "capped at 1000"
                      : "in this range"
                  }
                />
                <MetricCard
                  label="Pages w/ Clicks"
                  value={fmt(indexing.pagesWithClicks)}
                  sub={`${indexing.pagesWithImpressions > 0 ? Math.round((indexing.pagesWithClicks / indexing.pagesWithImpressions) * 100) : 0}% of indexed-active`}
                />
                <MetricCard
                  label="Total Impressions"
                  value={fmt(totals?.impressions ?? 0)}
                />
              </div>
              <p className="text-[11px] text-muted-foreground">
                Indexing here is approximated by pages that received GSC
                impressions in the date range. For verified indexing status,
                run URL Inspection from a scheduled audit.
              </p>
            </div>
          )}

          {/* Top queries */}
          <div className="space-y-2">
            <h3 className="font-sans text-xs font-extrabold uppercase tracking-[0.18em] text-muted-foreground">
              Top Queries
            </h3>
            {gsc.topQueries.length === 0 ? (
              <p className="text-xs text-muted-foreground">No queries.</p>
            ) : (
              <div className="overflow-hidden rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10 text-xs">#</TableHead>
                      <TableHead className="text-xs">Query</TableHead>
                      <TableHead className="text-right text-xs">
                        Clicks
                      </TableHead>
                      <TableHead className="text-right text-xs">
                        Impr.
                      </TableHead>
                      <TableHead className="text-right text-xs">CTR</TableHead>
                      <TableHead className="text-right text-xs">Pos</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {gsc.topQueries.slice(0, 25).map((q, i) => (
                      <TableRow key={`${q.query}-${i}`}>
                        <TableCell className="text-xs text-muted-foreground">
                          {i + 1}
                        </TableCell>
                        <TableCell
                          className="max-w-[360px] truncate text-xs"
                          title={q.query}
                        >
                          {q.query}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {q.clicks.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {q.impressions.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {fmtCtr(q.ctr)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {fmtPos(q.position)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            {gsc.topQueries.length > 25 && (
              <p className="text-[11px] text-muted-foreground">
                Showing top 25 of {gsc.topQueries.length} queries.
              </p>
            )}
          </div>

          {/* Top pages */}
          <div className="space-y-2">
            <h3 className="font-sans text-xs font-extrabold uppercase tracking-[0.18em] text-muted-foreground">
              Top Pages
            </h3>
            {gsc.topPages.length === 0 ? (
              <p className="text-xs text-muted-foreground">No pages.</p>
            ) : (
              <div className="overflow-hidden rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10 text-xs">#</TableHead>
                      <TableHead className="text-xs">Page</TableHead>
                      <TableHead className="text-right text-xs">
                        Clicks
                      </TableHead>
                      <TableHead className="text-right text-xs">
                        Impr.
                      </TableHead>
                      <TableHead className="text-right text-xs">CTR</TableHead>
                      <TableHead className="text-right text-xs">Pos</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {gsc.topPages.slice(0, 25).map((p, i) => {
                      const path = (() => {
                        try {
                          return new URL(p.page).pathname
                        } catch {
                          return p.page
                        }
                      })()
                      return (
                        <TableRow key={`${p.page}-${i}`}>
                          <TableCell className="text-xs text-muted-foreground">
                            {i + 1}
                          </TableCell>
                          <TableCell className="max-w-[360px] text-xs">
                            <a
                              href={p.page}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 truncate font-mono hover:text-foreground"
                              title={p.page}
                            >
                              <span className="truncate">{path}</span>
                              <ExternalLinkIcon className="size-3 shrink-0 opacity-50" />
                            </a>
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs tabular-nums">
                            {p.clicks.toLocaleString()}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs tabular-nums">
                            {p.impressions.toLocaleString()}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs tabular-nums">
                            {fmtCtr(p.ctr)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs tabular-nums">
                            {fmtPos(p.position)}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
            {gsc.topPages.length > 25 && (
              <p className="text-[11px] text-muted-foreground">
                Showing top 25 of {gsc.topPages.length} pages.
              </p>
            )}
          </div>
        </>
      )}

      {/* GA4 detail ------------------------------------------------------- */}
      <div className="space-y-3 border-t border-border pt-6">
        <div className="flex items-center justify-between">
          <h3 className="font-sans text-xs font-extrabold uppercase tracking-[0.18em] text-muted-foreground">
            GA4 Detail
          </h3>
          {!ga4PropertyId && (
            <Badge variant="outline" className="text-[10px] text-muted-foreground">
              GA4 not configured
            </Badge>
          )}
        </div>

        {ga4PropertyId &&
          (ga4.status === "loading" || ga4.status === "idle" ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div
                  key={i}
                  className="h-24 animate-pulse rounded-lg border bg-muted/30"
                />
              ))}
            </div>
          ) : ga4.status === "error" ? (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-900 dark:text-amber-200">
              {ga4.message}
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <MetricCard
                  label="Sessions"
                  value={fmt(ga4.report.sessions)}
                />
                <MetricCard label="Users" value={fmt(ga4.report.users)} />
                {ga4.report.conversionsConfigured ? (
                  <MetricCard
                    label="Conversions"
                    value={fmt(ga4.report.conversions)}
                  />
                ) : (
                  <MetricCard
                    label="Conversions"
                    value="—"
                    sub="not configured"
                  />
                )}
              </div>

              {ga4.report.organicOnly.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    Top Organic Landing Pages
                  </h4>
                  <div className="overflow-hidden rounded-lg border border-border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-10 text-xs">#</TableHead>
                          <TableHead className="text-xs">Landing Page</TableHead>
                          <TableHead className="text-right text-xs">
                            Sessions
                          </TableHead>
                          <TableHead className="text-right text-xs">
                            Conv.
                          </TableHead>
                          <TableHead className="text-right text-xs">
                            CVR
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {ga4.report.organicOnly.slice(0, 15).map((p, i) => (
                          <TableRow key={`${p.landingPage}-${i}`}>
                            <TableCell className="text-xs text-muted-foreground">
                              {i + 1}
                            </TableCell>
                            <TableCell
                              className="max-w-[420px] truncate font-mono text-xs"
                              title={p.landingPage}
                            >
                              {p.landingPage}
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs tabular-nums">
                              {p.sessions.toLocaleString()}
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs tabular-nums">
                              {p.conversions.toLocaleString()}
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs tabular-nums">
                              {fmtCtr(p.conversionRate)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}

              {ga4.report.trafficSources.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    Top Traffic Sources
                  </h4>
                  <div className="overflow-hidden rounded-lg border border-border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="text-xs">Source / Medium</TableHead>
                          <TableHead className="text-right text-xs">
                            Sessions
                          </TableHead>
                          <TableHead className="text-right text-xs">
                            Conv.
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {ga4.report.trafficSources.slice(0, 10).map((s, i) => (
                          <TableRow key={`${s.source}-${s.medium}-${i}`}>
                            <TableCell className="font-mono text-xs">
                              {s.source} / {s.medium}
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs tabular-nums">
                              {s.sessions.toLocaleString()}
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs tabular-nums">
                              {s.conversions.toLocaleString()}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}
            </>
          ))}
      </div>
    </section>
  )
}
