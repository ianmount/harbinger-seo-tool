"use client"

import { useState, type FormEvent } from "react"
import { Loader2, MapPin, Star } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { MarketPicker } from "@/components/tool/MarketPicker"
import { ToolShell } from "@/components/tool/ToolShell"
import {
  ToolError,
  ToolSection,
  useToolRun,
} from "@/components/tool/use-tool-run"
import { rankColor } from "@/lib/gbp-heatmap"
import { findToolByPathname } from "@/lib/tool-config"
import type { DfsLabsLocation } from "@/lib/types"

type GridPoint = {
  row: number
  col: number
  lat: number
  lng: number
  rank: number | null
  found_count: number
}

type Target = {
  title: string
  address: string | null
  place_id: string | null
  lat: number
  lng: number
  rating: number | null
  rating_count: number | null
  category: string | null
}

type Candidate = {
  title: string
  address: string | null
  place_id: string | null
  lat: number | null
  lng: number | null
  rating: number | null
  rating_count: number | null
  category: string | null
}

type Competitor = {
  title: string
  place_id: string | null
  rating: number | null
  rating_count: number | null
  avg_rank: number
  appearances: number
}

type Data = {
  status: "ok" | "ambiguous" | "not_found"
  target?: Target
  candidates?: Candidate[]
  grid?: {
    rows: number
    cols: number
    spacing_km: number
    points: GridPoint[]
  }
  kpis?: {
    total: number
    found: number
    avg_rank: number | null
    sov_percent: number
    good: number
    average: number
    poor: number
    oot20: number
  }
  competitors?: Competitor[]
  endpoints_called: string[]
}

type SubmitOverride = {
  place_id: string
  center_lat: number
  center_lng: number
  business_title: string
}

export default function GbpHeatmapPage() {
  const tool = findToolByPathname("/local/gbp-heatmap")!
  const [business, setBusiness] = useState("")
  const [keyword, setKeyword] = useState("")
  const [market, setMarket] = useState<DfsLabsLocation | null>(null)
  const { data, meta, loading, error, run, setError } =
    useToolRun<Data>("/api/tools/local/gbp-heatmap")

  async function submit(override?: SubmitOverride) {
    if (!business.trim()) return setError("Enter a business name.")
    if (!keyword.trim()) return setError("Enter a keyword.")
    if (!override && !market) return setError("Pick a market (city/state).")
    await run({
      business: business.trim(),
      keyword: keyword.trim(),
      location_code: market?.location_code,
      location_name: market ? undefined : "United States",
      ...override,
    })
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    await submit()
  }

  function selectCandidate(c: Candidate) {
    if (c.lat == null || c.lng == null || !c.place_id) return
    submit({
      place_id: c.place_id,
      center_lat: c.lat,
      center_lng: c.lng,
      business_title: c.title,
    })
  }

  return (
    <ToolShell
      category="Local"
      title={tool.label}
      description={tool.description}
      endpoints={tool.endpoints}
      meta={meta}
      form={
        <form
          onSubmit={onSubmit}
          className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_1fr_260px_auto] md:items-end"
        >
          <div className="space-y-1.5">
            <Label htmlFor="business">Business name</Label>
            <Input
              id="business"
              value={business}
              onChange={(e) => setBusiness(e.target.value)}
              placeholder="Shade Number Seven"
              disabled={loading}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="keyword">Keyword</Label>
            <Input
              id="keyword"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="window blinds"
              disabled={loading}
            />
          </div>
          <MarketPicker value={market} onChange={setMarket} label="City" />
          <Button type="submit" disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Run Heatmap Scan
          </Button>
        </form>
      }
      results={
        error ? (
          <ToolError message={error} />
        ) : !data ? (
          loading ? <ScanProgress /> : null
        ) : data.status === "not_found" ? (
          <NotFoundPanel business={business} />
        ) : data.status === "ambiguous" ? (
          <Disambiguation
            candidates={data.candidates ?? []}
            onPick={selectCandidate}
            disabled={loading}
          />
        ) : (
          <>
            <ToolSection title="Target Business">
              <TargetCard target={data.target} />
            </ToolSection>
            <ToolSection title="Rank KPIs">
              <KpiGrid kpis={data.kpis} />
            </ToolSection>
            <ToolSection
              title="Geographic Heatmap"
              description={
                data.grid
                  ? `${data.grid.rows}×${data.grid.cols} grid · ${data.grid.spacing_km}km spacing · ${data.grid.points.length} vantage points`
                  : undefined
              }
            >
              <HeatmapPanel
                grid={data.grid}
                competitors={data.competitors ?? []}
                target={data.target}
              />
            </ToolSection>
          </>
        )
      }
    />
  )
}

function ScanProgress() {
  return (
    <div className="rounded-xl border border-dashed border-line bg-card/40 px-6 py-10 text-center">
      <Loader2 className="mx-auto h-6 w-6 animate-spin text-ink-3" />
      <p className="mt-3 font-sans text-[13px] font-semibold text-foreground">
        Scanning Google Maps from each grid vantage point…
      </p>
      <p className="mt-1 font-serif text-[12px] text-ink-3">
        ~10-30 seconds. Resolving business, then running 35 parallel SERP
        calls.
      </p>
    </div>
  )
}

function NotFoundPanel({ business }: { business: string }) {
  return (
    <div className="rounded-xl border border-amber-300/60 bg-amber-50/60 px-5 py-4">
      <p className="font-sans text-[13px] font-bold text-amber-900">
        No matching Google Business Profile found
      </p>
      <p className="mt-1 font-serif text-[12px] text-amber-900/80">
        Google Business Profile didn&apos;t return any listing for{" "}
        <strong>{business}</strong> in this market. Try a different name
        variant or verify the business has a published GBP. Without a GBP, a
        geo-grid scan isn&apos;t meaningful — flag this as a prerequisite for
        local rank tracking.
      </p>
    </div>
  )
}

function Disambiguation({
  candidates,
  onPick,
  disabled,
}: {
  candidates: Candidate[]
  onPick: (c: Candidate) => void
  disabled: boolean
}) {
  return (
    <div className="space-y-3">
      <div>
        <p className="font-sans text-[13px] font-bold text-foreground">
          Multiple matches — pick the right business
        </p>
        <p className="font-serif text-[12px] text-ink-3">
          Google Business Profile returned more than one candidate. Selecting
          one will trigger the 35-point scan against that location.
        </p>
      </div>
      <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {candidates.map((c, i) => (
          <li key={`${c.place_id ?? c.title}-${i}`}>
            <button
              type="button"
              onClick={() => onPick(c)}
              disabled={disabled || c.place_id == null}
              className="group flex w-full flex-col gap-1.5 rounded-lg border border-line bg-card px-4 py-3 text-left transition-colors hover:border-brand-red/50 hover:bg-card/80 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="font-sans text-[13px] font-semibold text-foreground">
                {c.title || "Unknown business"}
              </span>
              <span className="font-mono text-[11px] text-ink-3">
                {c.address ?? "no address"}
              </span>
              <span className="flex items-center gap-3 text-[11px] text-ink-2">
                {c.rating != null ? (
                  <span className="inline-flex items-center gap-1">
                    <Star className="h-3 w-3 fill-amber-400 stroke-amber-500" />
                    {c.rating.toFixed(1)}
                    {c.rating_count != null ? ` · ${c.rating_count}` : ""}
                  </span>
                ) : null}
                {c.category ? <span>{c.category}</span> : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function TargetCard({ target }: { target: Target | undefined }) {
  if (!target) return null
  return (
    <div className="rounded-xl border border-line bg-card px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 font-sans text-[14px] font-semibold text-foreground">
            {target.title}
            <Badge variant="default">You</Badge>
          </p>
          {target.address ? (
            <p className="mt-1 inline-flex items-center gap-1.5 font-mono text-[11px] text-ink-3">
              <MapPin className="h-3 w-3" /> {target.address}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-4 text-[11.5px] text-ink-2">
          {target.rating != null ? (
            <span className="inline-flex items-center gap-1">
              <Star className="h-3.5 w-3.5 fill-amber-400 stroke-amber-500" />
              {target.rating.toFixed(1)}
              {target.rating_count != null ? ` · ${target.rating_count}` : ""}
            </span>
          ) : null}
          {target.category ? <span>{target.category}</span> : null}
          <span className="font-mono text-[10.5px] text-ink-3">
            {target.lat.toFixed(5)}, {target.lng.toFixed(5)}
          </span>
        </div>
      </div>
    </div>
  )
}

function KpiGrid({ kpis }: { kpis: Data["kpis"] }) {
  if (!kpis) return null
  const items = [
    {
      label: "Avg rank",
      value: kpis.avg_rank == null ? "—" : kpis.avg_rank.toFixed(1),
      color: undefined,
    },
    {
      label: "Share of voice",
      value: `${kpis.sov_percent.toFixed(1)}%`,
      sub: `${kpis.good} of ${kpis.total} in top 3`,
      color: undefined,
    },
    {
      label: "Good",
      value: `${pct(kpis.good, kpis.total)}%`,
      sub: `${kpis.good} of ${kpis.total}`,
      color: "#0F6E56",
    },
    {
      label: "Average",
      value: `${pct(kpis.average, kpis.total)}%`,
      sub: `${kpis.average} of ${kpis.total}`,
      color: "#EF9F27",
    },
    {
      label: "Poor",
      value: `${pct(kpis.poor, kpis.total)}%`,
      sub: `${kpis.poor} of ${kpis.total}`,
      color: "#D85A30",
    },
    {
      label: "Out of top 20",
      value: `${pct(kpis.oot20, kpis.total)}%`,
      sub: `${kpis.oot20} of ${kpis.total}`,
      color: "#9D9D9D",
    },
  ]
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
      {items.map((it) => (
        <div
          key={it.label}
          className="flex flex-col gap-0.5 rounded-lg bg-muted/40 px-3.5 py-3"
        >
          <span className="font-sans text-[10.5px] uppercase tracking-[0.08em] text-ink-3">
            {it.label}
          </span>
          <span
            className="font-sans text-[20px] font-semibold leading-tight"
            style={it.color ? { color: it.color } : undefined}
          >
            {it.value}
          </span>
          {it.sub ? (
            <span className="font-mono text-[10.5px] text-ink-3">{it.sub}</span>
          ) : null}
        </div>
      ))}
    </div>
  )
}

function pct(part: number, total: number): string {
  if (total === 0) return "0.0"
  return ((part / total) * 100).toFixed(1)
}

function HeatmapPanel({
  grid,
  competitors,
  target,
}: {
  grid: Data["grid"]
  competitors: Competitor[]
  target: Target | undefined
}) {
  if (!grid) return null
  const totalPoints = grid.points.length
  const targetRanks = grid.points
    .map((p) => p.rank)
    .filter((r): r is number => typeof r === "number")
  const targetAvgRank =
    targetRanks.length > 0
      ? targetRanks.reduce((a, b) => a + b, 0) / targetRanks.length
      : null
  return (
    <div className="rounded-xl border border-line bg-card">
      <div className="grid grid-cols-1 md:grid-cols-[220px_1fr]">
        <CompetitorSidebar
          competitors={competitors}
          target={target}
          targetAvgRank={targetAvgRank}
          totalPoints={totalPoints}
        />
        <div className="border-t border-line p-4 md:border-l md:border-t-0">
          <HeatmapGrid grid={grid} />
          <Legend />
        </div>
      </div>
    </div>
  )
}

function CompetitorSidebar({
  competitors,
  target,
  targetAvgRank,
  totalPoints,
}: {
  competitors: Competitor[]
  target: Target | undefined
  targetAvgRank: number | null
  totalPoints: number
}) {
  return (
    <div className="p-3.5">
      <p className="mb-2.5 font-sans text-[10.5px] uppercase tracking-[0.08em] text-ink-3">
        Businesses
      </p>
      <ul className="space-y-1">
        {target ? (
          <li className="rounded-md border-l-[3px] border-l-[#0F6E56] bg-muted/40 px-2 py-2">
            <div className="flex items-start justify-between gap-2">
              <span className="font-sans text-[12px] font-semibold text-foreground">
                {target.title}
              </span>
              <Badge variant="default" className="h-4 px-1.5 text-[9px]">
                You
              </Badge>
            </div>
            <div className="mt-1 flex items-center justify-between">
              <span className="font-mono text-[10px] text-ink-3">
                {target.rating != null
                  ? `★ ${target.rating.toFixed(1)}${target.rating_count != null ? ` · ${target.rating_count}` : ""}`
                  : "—"}
              </span>
              <span className="font-mono text-[10px] text-ink-3">
                {targetAvgRank != null ? `AR ${targetAvgRank.toFixed(1)}` : ""}
              </span>
            </div>
          </li>
        ) : null}
        {competitors.map((c, i) => (
          <li
            key={`${c.place_id ?? c.title}-${i}`}
            className="rounded-md px-2 py-2 hover:bg-muted/40"
          >
            <span className="block font-sans text-[12px] font-semibold text-foreground">
              {c.title}
            </span>
            <div className="mt-1 flex items-center justify-between">
              <span className="font-mono text-[10px] text-ink-3">
                {c.rating != null
                  ? `★ ${c.rating.toFixed(1)}${c.rating_count != null ? ` · ${c.rating_count}` : ""}`
                  : "—"}
              </span>
              <span className="font-mono text-[10px] text-ink-3">
                AR {c.avg_rank.toFixed(1)}
                <span className="ml-1.5 text-ink-3/70">
                  ({c.appearances}/{totalPoints})
                </span>
              </span>
            </div>
          </li>
        ))}
        {competitors.length === 0 ? (
          <li className="font-serif text-[11px] text-ink-3">
            No competitors found across the grid.
          </li>
        ) : null}
      </ul>
    </div>
  )
}

function HeatmapGrid({ grid }: { grid: NonNullable<Data["grid"]> }) {
  const { rows, cols, points } = grid
  const cellSize = 60
  const padding = 30
  const width = padding * 2 + cellSize * (cols - 1)
  const height = padding * 2 + cellSize * (rows - 1)
  const targetRow = Math.floor(rows / 2)
  const targetCol = Math.floor(cols / 2)

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      style={{ width: "100%", height: "auto", display: "block" }}
      role="img"
      aria-label={`Geographic grid of ${points.length} rank markers around the target business.`}
      className="rounded-lg bg-brand-paper"
    >
      <rect
        x={0}
        y={0}
        width={width}
        height={height}
        fill="#F5F4ED"
        rx={6}
      />
      {points.map((p) => {
        const cx = padding + p.col * cellSize
        const cy = padding + p.row * cellSize
        const isCenter = p.row === targetRow && p.col === targetCol
        const fill = rankColor(p.rank)
        const r = isCenter ? 17 : 15
        const text = p.rank == null ? "—" : String(p.rank)
        return (
          <g key={`${p.row}-${p.col}`}>
            <circle
              cx={cx}
              cy={cy}
              r={r}
              fill={fill}
              stroke={isCenter ? "#FF1E00" : undefined}
              strokeWidth={isCenter ? 3 : 0}
            />
            <text
              x={cx}
              y={cy + 4}
              textAnchor="middle"
              fill="white"
              fontSize={isCenter ? 12 : 11}
              fontWeight={isCenter ? 600 : 500}
            >
              {text}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

function Legend() {
  const items: { label: string; color: string }[] = [
    { label: "Good 1-3", color: "#0F6E56" },
    { label: "Average 4-10", color: "#EF9F27" },
    { label: "Poor 11-20", color: "#D85A30" },
    { label: "Out of top 20", color: "#9D9D9D" },
  ]
  return (
    <div className="mt-3 flex flex-wrap items-center gap-4 text-[11px] text-ink-2">
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5">
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: it.color }}
          />
          {it.label}
        </span>
      ))}
      <span className="ml-auto inline-flex items-center gap-1.5">
        <span
          className="h-3 w-3 rounded-full"
          style={{
            backgroundColor: "#0F6E56",
            boxShadow: "0 0 0 2px #FF1E00",
          }}
        />
        Business location
      </span>
    </div>
  )
}
