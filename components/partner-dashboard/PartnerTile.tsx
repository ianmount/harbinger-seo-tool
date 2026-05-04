"use client"

import Link from "next/link"
import { AlertTriangle, CheckCircle2, Clock, TrendingDown, TrendingUp } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { PartnerSnapshot } from "@/lib/types"

function fmt(n: number, decimals = 0): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toFixed(decimals)
}

function fmtPos(n: number | null): string {
  if (n === null) return "—"
  return n.toFixed(1)
}

function fmtCtr(n: number): string {
  return `${(n * 100).toFixed(1)}%`
}

function delta(current: number | null, prior: number | null): number | null {
  if (current === null || prior === null || prior === 0) return null
  return (current - prior) / prior
}

function DeltaBadge({ value, invert = false }: { value: number | null; invert?: boolean }) {
  if (value === null) return null
  const pct = Math.abs(value * 100)
  if (pct < 0.5) return null
  const positive = invert ? value < 0 : value > 0
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 font-mono text-[10px]",
        positive ? "text-emerald-600" : "text-red-500",
      )}
    >
      {positive ? (
        <TrendingUp className="size-2.5" />
      ) : (
        <TrendingDown className="size-2.5" />
      )}
      {pct.toFixed(0)}%
    </span>
  )
}

function Stat({
  label,
  value,
  delta: d,
  invertDelta,
}: {
  label: string
  value: string
  delta?: number | null
  invertDelta?: boolean
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[9.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </span>
      <span className="font-mono text-sm font-semibold tabular-nums leading-none">
        {value}
      </span>
      {d !== undefined && <DeltaBadge value={d} invert={invertDelta} />}
    </div>
  )
}

export function PartnerTile({ snapshot }: { snapshot: PartnerSnapshot }) {
  const { partner, current, prior, ga4, latestRun, error, gscSiteUrl } =
    snapshot

  const clicksDelta = delta(current?.clicks ?? null, prior?.clicks ?? null)
  const impressionsDelta = delta(
    current?.impressions ?? null,
    prior?.impressions ?? null,
  )
  const positionDelta = delta(
    current?.avgPosition ?? null,
    prior?.avgPosition ?? null,
  )

  const runStatus = latestRun?.status
  const hasAttention = latestRun?.needsAttention

  return (
    <Link
      href={`/partners/${partner.id}`}
      className="group flex flex-col gap-3 rounded-xl border border-border bg-card p-4 transition-all hover:border-brand-red/40 hover:shadow-md"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-sans text-sm font-bold leading-tight text-foreground group-hover:text-brand-red">
            {partner.name}
          </p>
          <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
            {partner.website.replace(/^https?:\/\//, "")}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {hasAttention && (
            <Badge
              variant="outline"
              className="border-amber-500/40 bg-amber-500/10 text-[9px] text-amber-700"
            >
              <AlertTriangle className="mr-1 size-2.5" />
              attention
            </Badge>
          )}
          {runStatus === "running" && (
            <Badge variant="outline" className="text-[9px]">
              <Clock className="mr-1 size-2.5" />
              crawling
            </Badge>
          )}
          {runStatus === "completed" && !hasAttention && (
            <CheckCircle2 className="size-3.5 text-emerald-500" />
          )}
        </div>
      </div>

      {/* GSC stats */}
      {error ? (
        <p className="text-[10px] text-destructive">{error}</p>
      ) : !gscSiteUrl ? (
        <p className="text-[10px] text-muted-foreground">GSC not configured</p>
      ) : current ? (
        <div className="grid grid-cols-2 gap-x-3 gap-y-2">
          <Stat
            label="Clicks"
            value={fmt(current.clicks)}
            delta={clicksDelta}
          />
          <Stat
            label="Impressions"
            value={fmt(current.impressions)}
            delta={impressionsDelta}
          />
          <Stat
            label="Avg Pos"
            value={fmtPos(current.avgPosition)}
            delta={positionDelta}
            invertDelta
          />
          <Stat
            label="CTR"
            value={fmtCtr(current.avgCtr)}
          />
        </div>
      ) : (
        <p className="text-[10px] text-muted-foreground">No GSC data</p>
      )}

      {/* GA4 sessions + conversions */}
      {ga4 && (
        <div className="flex items-center gap-3 border-t border-border pt-2">
          <Stat label="Sessions" value={fmt(ga4.sessions)} />
          {ga4.conversionsConfigured && (
            <Stat label="Conversions" value={fmt(ga4.conversions)} />
          )}
        </div>
      )}
    </Link>
  )
}
