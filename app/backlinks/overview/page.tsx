"use client"

import { useState, type FormEvent } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ToolShell } from "@/components/tool/ToolShell"
import { ToolError, useToolRun } from "@/components/tool/use-tool-run"
import { findToolByPathname } from "@/lib/tool-config"
import { cn } from "@/lib/utils"

type SpamRating = { target: string; spam_score: number | null }

type Summary = {
  backlinks: number | null
  referring_domains: number | null
  rank: number | null
  referring_ips: number | null
  referring_subnets: number | null
  broken_backlinks: number | null
}

type DomainRow = {
  domain: string
  backlinks: number | null
  rank: number | null
  spam_score: number | null
  first_seen: string | null
  is_lost: boolean
}

type AnchorRow = {
  anchor: string
  backlinks: number | null
  referring_domains: number | null
  dofollow: number | null
  first_seen: string | null
}

type TimeseriesPoint = {
  date: string
  new_backlinks: number
  lost_backlinks: number
}

type NetworkRow = {
  network_address: string
  referring_domains: number | null
  backlinks: number | null
}

type SectionResult<T> = { data: T; error: null } | { data: null; error: string }

type Data = {
  spam: SectionResult<SpamRating>
  summary: SectionResult<Summary>
  domains: SectionResult<DomainRow[]>
  anchors: SectionResult<AnchorRow[]>
  timeseries: SectionResult<TimeseriesPoint[]>
  networks: SectionResult<NetworkRow[]>
}

const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
]

function fmtInt(n: number | null): string {
  if (n == null) return "—"
  return n.toLocaleString()
}

function fmtDate(s: string | null): string {
  if (!s) return "—"
  return s.slice(0, 10)
}

function spamTier(score: number | null): "lo" | "med" | "hi" {
  if (score == null) return "lo"
  if (score >= 60) return "hi"
  if (score >= 30) return "med"
  return "lo"
}

function spamLabel(score: number | null): string {
  const tier = spamTier(score)
  if (tier === "hi") return "High risk"
  if (tier === "med") return "Medium risk"
  return "Low risk"
}

const tierTagClasses: Record<"lo" | "med" | "hi", string> = {
  lo: "bg-success-light text-success-dark",
  med: "bg-warning-light text-warning-dark",
  hi: "bg-danger-light text-danger-dark",
}

const tierPillClasses: Record<"lo" | "med" | "hi", string> = {
  lo: "bg-success-light text-success-dark",
  med: "bg-warning-light text-warning-dark",
  hi: "bg-danger-light text-danger-dark",
}

const tierTextClasses: Record<"lo" | "med" | "hi", string> = {
  lo: "text-success-dark",
  med: "text-warning-dark",
  hi: "text-danger-dark",
}

function SpamHero({ score }: { score: number | null }) {
  const tier = spamTier(score)
  const markerPct = Math.max(0, Math.min(100, score ?? 0))
  return (
    <div className="grid items-center gap-6 sm:grid-cols-[auto_1fr]">
      <div className="flex items-baseline gap-1">
        <span
          className={cn(
            "font-sans text-[56px] font-semibold leading-none tabular-nums",
            tierTextClasses[tier],
          )}
        >
          {score ?? "—"}
        </span>
        <span className="font-sans text-[18px] text-ink-3 tabular-nums">
          /100
        </span>
      </div>
      <div className="flex flex-col gap-2.5">
        <span
          className={cn(
            "inline-block self-start rounded-full px-2.5 py-0.5 font-sans text-[12px] font-semibold",
            tierTagClasses[tier],
          )}
        >
          {spamLabel(score)}
        </span>
        <div className="relative h-3 overflow-hidden rounded-full">
          <div className="flex h-full w-full">
            <div className="h-full w-[30%] bg-success-light" />
            <div className="h-full w-[30%] bg-warning-light" />
            <div className="h-full w-[40%] bg-danger-light" />
          </div>
          <div
            className="absolute -top-[3px] -bottom-[3px] w-[3px] rounded-sm bg-foreground"
            style={{ left: `calc(${markerPct}% - 1.5px)` }}
            aria-hidden
          />
        </div>
        <div className="flex justify-between font-mono text-[11px] text-ink-3 tabular-nums">
          <span>0</span>
          <span>30 low</span>
          <span>60 medium</span>
          <span>100 high</span>
        </div>
      </div>
    </div>
  )
}

function KpiGrid({ summary }: { summary: Summary }) {
  const kpis: { label: string; value: number | null }[] = [
    { label: "backlinks", value: summary.backlinks },
    { label: "referring_domains", value: summary.referring_domains },
    { label: "rank", value: summary.rank },
    { label: "referring_ips", value: summary.referring_ips },
    { label: "referring_subnets", value: summary.referring_subnets },
    { label: "broken_backlinks", value: summary.broken_backlinks },
  ]
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {kpis.map((k) => (
        <div
          key={k.label}
          className="rounded-md bg-muted px-3 py-2.5"
        >
          <div className="font-mono text-[11px] text-ink-3">{k.label}</div>
          <div className="font-sans text-[20px] font-semibold tabular-nums">
            {fmtInt(k.value)}
          </div>
        </div>
      ))}
    </div>
  )
}

function NewLostChart({ points }: { points: TimeseriesPoint[] }) {
  // Bucket by YYYY-MM and take the last 12 months in chronological order.
  // DFS often returns a row per month; collapse duplicates by month-key.
  const byMonth = new Map<string, { newB: number; lostB: number }>()
  for (const p of points) {
    const key = p.date.slice(0, 7)
    const prev = byMonth.get(key) ?? { newB: 0, lostB: 0 }
    byMonth.set(key, {
      newB: prev.newB + p.new_backlinks,
      lostB: prev.lostB + p.lost_backlinks,
    })
  }
  const months = Array.from(byMonth.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-12)

  if (months.length === 0) {
    return (
      <p className="font-serif text-[13px] text-ink-3">
        No new/lost backlink data for the last 12 months.
      </p>
    )
  }

  const maxVal = Math.max(
    1,
    ...months.flatMap(([, v]) => [v.newB, v.lostB]),
  )

  return (
    <div className="space-y-2">
      <div
        className="grid items-end gap-1.5"
        style={{
          gridTemplateColumns: `repeat(${months.length}, minmax(0, 1fr))`,
          height: "120px",
        }}
      >
        {months.map(([key, v]) => {
          const newPct = (v.newB / maxVal) * 100
          const lostPct = (v.lostB / maxVal) * 100
          return (
            <div key={key} className="flex h-full items-end gap-[2px]">
              <div
                className="flex-1 min-h-[1px] rounded-t-sm bg-info"
                style={{ height: `${newPct}%` }}
                title={`${key} · new: ${v.newB.toLocaleString()}`}
                aria-label={`${key} new ${v.newB}`}
              />
              <div
                className="flex-1 min-h-[1px] rounded-t-sm bg-ink-3/55"
                style={{ height: `${lostPct}%` }}
                title={`${key} · lost: ${v.lostB.toLocaleString()}`}
                aria-label={`${key} lost ${v.lostB}`}
              />
            </div>
          )
        })}
      </div>
      <div
        className="grid gap-1.5 text-center font-mono text-[11px] text-ink-3"
        style={{
          gridTemplateColumns: `repeat(${months.length}, minmax(0, 1fr))`,
        }}
      >
        {months.map(([key]) => {
          const month = Number(key.slice(5, 7))
          return <span key={key}>{MONTH_LABELS[month - 1] ?? key}</span>
        })}
      </div>
      <div className="flex gap-4 font-mono text-[11px] text-ink-2">
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block h-2.5 w-2.5 rounded-sm bg-info" aria-hidden />
          new
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i
            className="inline-block h-2.5 w-2.5 rounded-sm bg-ink-3/55"
            aria-hidden
          />
          lost
        </span>
      </div>
    </div>
  )
}

function SectionCard({
  title,
  endpoint,
  children,
}: {
  title: string
  endpoint: string
  children: React.ReactNode
}) {
  return (
    <Card className="gap-3 px-5 py-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-sans text-[15px] font-semibold tracking-tight">
          {title}
        </h3>
        <code className="font-mono text-[11.5px] text-ink-3">{endpoint}</code>
      </div>
      <div>{children}</div>
    </Card>
  )
}

function SectionError({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 font-mono text-[12px] text-destructive">
      {message}
    </div>
  )
}

function withResult<T>(
  result: SectionResult<T>,
  render: (data: T) => React.ReactNode,
): React.ReactNode {
  if (result.error) return <SectionError message={result.error} />
  return render(result.data as T)
}

function SpamPill({ score }: { score: number | null }) {
  if (score == null) return <span className="text-ink-3">—</span>
  const tier = spamTier(score)
  return (
    <span
      className={cn(
        "inline-block min-w-[28px] rounded-full px-2 py-0.5 text-center font-mono text-[12px] font-semibold tabular-nums",
        tierPillClasses[tier],
      )}
    >
      {score}
    </span>
  )
}

export default function BacklinkOverviewPage() {
  const tool = findToolByPathname("/backlinks/overview")!
  const [target, setTarget] = useState("")
  const { data, meta, loading, error, run, setError } = useToolRun<Data>(
    "/api/tools/backlinks/overview",
  )

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!target.trim()) {
      setError("Enter a domain or URL.")
      return
    }
    await run({ target: target.trim() })
  }

  return (
    <ToolShell
      category="Backlinks"
      title={tool.label}
      description={tool.description}
      endpoints={tool.endpoints}
      meta={meta}
      form={
        <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
          <div className="grow space-y-1.5 min-w-[260px]">
            <Label htmlFor="target">Target domain</Label>
            <Input
              id="target"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="examplepartner.com"
              disabled={loading}
            />
          </div>
          <Button type="submit" disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Run audit
          </Button>
        </form>
      }
      results={
        error ? (
          <ToolError message={error} />
        ) : data ? (
          <div className="space-y-3">
            <SectionCard
              title="Spam rating"
              endpoint="POST /v3/backlinks/bulk_spam_score"
            >
              {withResult(data.spam, (d) => (
                <SpamHero score={d.spam_score} />
              ))}
            </SectionCard>

            <SectionCard
              title="Summary"
              endpoint="POST /v3/backlinks/summary"
            >
              {withResult(data.summary, (d) => (
                <KpiGrid summary={d} />
              ))}
            </SectionCard>

            <SectionCard
              title="Referring domains"
              endpoint="POST /v3/backlinks/referring_domains"
            >
              {withResult(data.domains, (rows) =>
                rows.length === 0 ? (
                  <p className="font-serif text-[13px] text-ink-3">
                    No referring domains returned.
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>domain</TableHead>
                        <TableHead className="text-right">backlinks</TableHead>
                        <TableHead className="text-right">rank</TableHead>
                        <TableHead className="text-right">spam_score</TableHead>
                        <TableHead>first_seen</TableHead>
                        <TableHead>is_lost</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((r) => (
                        <TableRow key={r.domain}>
                          <TableCell className="font-mono text-[12.5px]">
                            {r.domain}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {fmtInt(r.backlinks)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {fmtInt(r.rank)}
                          </TableCell>
                          <TableCell className="text-right">
                            <SpamPill score={r.spam_score} />
                          </TableCell>
                          <TableCell className="tabular-nums">
                            {fmtDate(r.first_seen)}
                          </TableCell>
                          <TableCell>{r.is_lost ? "true" : "false"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ),
              )}
            </SectionCard>

            <SectionCard
              title="Anchors"
              endpoint="POST /v3/backlinks/anchors"
            >
              {withResult(data.anchors, (rows) =>
                rows.length === 0 ? (
                  <p className="font-serif text-[13px] text-ink-3">
                    No anchor data returned.
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>anchor</TableHead>
                        <TableHead className="text-right">backlinks</TableHead>
                        <TableHead className="text-right">
                          referring_domains
                        </TableHead>
                        <TableHead className="text-right">dofollow</TableHead>
                        <TableHead>first_seen</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((r) => (
                        <TableRow key={r.anchor}>
                          <TableCell className="font-serif">
                            {r.anchor || "(empty)"}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {fmtInt(r.backlinks)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {fmtInt(r.referring_domains)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {fmtInt(r.dofollow)}
                          </TableCell>
                          <TableCell className="tabular-nums">
                            {fmtDate(r.first_seen)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ),
              )}
            </SectionCard>

            <SectionCard
              title="New vs lost over time"
              endpoint="POST /v3/backlinks/timeseries_new_lost_summary"
            >
              {withResult(data.timeseries, (points) => (
                <NewLostChart points={points} />
              ))}
            </SectionCard>

            <SectionCard
              title="Referring networks"
              endpoint="POST /v3/backlinks/referring_networks"
            >
              {withResult(data.networks, (rows) =>
                rows.length === 0 ? (
                  <p className="font-serif text-[13px] text-ink-3">
                    No referring networks returned.
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>network_address</TableHead>
                        <TableHead className="text-right">
                          referring_domains
                        </TableHead>
                        <TableHead className="text-right">backlinks</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((r) => (
                        <TableRow key={r.network_address}>
                          <TableCell className="font-mono text-[12.5px]">
                            {r.network_address}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {fmtInt(r.referring_domains)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {fmtInt(r.backlinks)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ),
              )}
            </SectionCard>
          </div>
        ) : null
      }
    />
  )
}
