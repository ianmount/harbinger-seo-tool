"use client"

import { useMemo, useState, type FormEvent } from "react"
import { Loader2, MapPin, Printer, Star } from "lucide-react"
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
import {
  HeatmapMap,
  isGoogleMapsConfigured,
} from "@/components/tool/HeatmapMap"
import { rankColor } from "@/lib/gbp-heatmap"
import { findToolByPathname } from "@/lib/tool-config"
import { cn } from "@/lib/utils"
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
  lat: number | null
  lng: number | null
  address: string | null
  avg_rank: number
  appearances: number
  ranks: (number | null)[]
}

type Kpis = {
  total: number
  found: number
  avg_rank: number | null
  sov_percent: number
  good: number
  average: number
  poor: number
  oot20: number
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
  kpis?: Kpis
  competitors?: Competitor[]
  endpoints_called: string[]
}

type SubmitOverride = {
  place_id: string
  center_lat: number
  center_lng: number
  business_title: string
}

/**
 * Identifier for the entity whose ranks are currently displayed across the
 * grid. "target" = the scanned business (default). A string value is the
 * place_id of one of the competitors, or `"title:<lowercased>"` as a
 * fallback for the rare competitor that DFSEO returns without a place_id.
 */
type SelectedKey = "target" | string

function competitorKey(c: Competitor): string {
  return c.place_id ?? `title:${c.title.toLowerCase()}`
}

function kpisFromRanks(ranks: readonly (number | null)[]): Kpis {
  let good = 0
  let average = 0
  let poor = 0
  let oot20 = 0
  let rankSum = 0
  let found = 0
  for (const r of ranks) {
    if (r == null) {
      oot20++
    } else if (r <= 3) {
      good++
    } else if (r <= 10) {
      average++
    } else if (r <= 20) {
      poor++
    } else {
      oot20++
    }
    if (typeof r === "number") {
      rankSum += r
      found++
    }
  }
  const total = ranks.length
  return {
    total,
    found,
    avg_rank: found > 0 ? rankSum / found : null,
    sov_percent: total > 0 ? (good / total) * 100 : 0,
    good,
    average,
    poor,
    oot20,
  }
}

export default function GbpHeatmapPage() {
  const tool = findToolByPathname("/local/gbp-heatmap")!
  const [business, setBusiness] = useState("")
  const [keyword, setKeyword] = useState("")
  const [market, setMarket] = useState<DfsLabsLocation | null>(null)
  const [selected, setSelected] = useState<SelectedKey>("target")
  const { data, meta, loading, error, run, setError } =
    useToolRun<Data>("/api/tools/local/gbp-heatmap")

  async function submit(override?: SubmitOverride) {
    if (!business.trim()) return setError("Enter a business name.")
    if (!keyword.trim()) return setError("Enter a keyword.")
    if (!override && !market) return setError("Pick a market (city/state).")
    setSelected("target")
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

  function exportPdf() {
    if (typeof window !== "undefined") window.print()
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
          className="grid grid-cols-1 gap-4 print:hidden md:grid-cols-[1fr_1fr_260px_auto] md:items-end"
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
          <ResultsView
            data={data}
            selected={selected}
            onSelect={setSelected}
            onExport={exportPdf}
            keyword={keyword}
          />
        )
      }
    />
  )
}

function ResultsView({
  data,
  selected,
  onSelect,
  onExport,
  keyword,
}: {
  data: Data
  selected: SelectedKey
  onSelect: (s: SelectedKey) => void
  onExport: () => void
  keyword: string
}) {
  const grid = data.grid
  const target = data.target
  const competitors = useMemo(() => data.competitors ?? [], [data.competitors])
  // Target rank values from the grid, in point-order.
  const targetRanks = useMemo<(number | null)[]>(
    () => (grid?.points.map((p) => p.rank) ?? []),
    [grid],
  )

  // Resolve the currently-displayed entity (target or one of the
  // competitors). All downstream views (map, KPIs, target card) read
  // from `view`.
  const view = useMemo(() => {
    if (!target || !grid) return null
    if (selected === "target") {
      return {
        kind: "target" as const,
        title: target.title,
        address: target.address,
        rating: target.rating,
        rating_count: target.rating_count,
        category: target.category,
        lat: target.lat,
        lng: target.lng,
        place_id: target.place_id,
        ranks: targetRanks,
        appearances: targetRanks.filter((r) => r != null).length,
        kpis: kpisFromRanks(targetRanks),
      }
    }
    const c = competitors.find((x) => competitorKey(x) === selected)
    if (!c) return null
    return {
      kind: "competitor" as const,
      title: c.title,
      address: c.address,
      rating: c.rating,
      rating_count: c.rating_count,
      category: null as string | null,
      // Fall back to the target's center if the competitor lacks coords
      // (rare). The map still renders sanely.
      lat: c.lat ?? target.lat,
      lng: c.lng ?? target.lng,
      place_id: c.place_id,
      ranks: c.ranks,
      appearances: c.appearances,
      kpis: kpisFromRanks(c.ranks),
    }
  }, [selected, target, grid, competitors, targetRanks])

  if (!view || !grid || !target) return null

  return (
    <div className="space-y-6">
      <PrintHeader keyword={keyword} target={target} viewTitle={view.title} />
      <ToolSection title={view.kind === "target" ? "Target Business" : "Viewing competitor"}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1">
            <EntityCard view={view} />
          </div>
          <div className="print:hidden">
            <Button
              type="button"
              variant="outline"
              onClick={onExport}
              className="shrink-0"
            >
              <Printer className="mr-2 h-4 w-4" />
              Export PDF
            </Button>
          </div>
        </div>
      </ToolSection>

      <ToolSection title="Rank KPIs">
        <KpiGrid kpis={view.kpis} />
      </ToolSection>

      <ToolSection
        title="Geographic Heatmap"
        description={`${grid.rows}×${grid.cols} grid · ${grid.spacing_km}km spacing · ${grid.points.length} vantage points`}
      >
        <HeatmapPanel
          grid={grid}
          competitors={competitors}
          target={target}
          targetRanks={targetRanks}
          selected={selected}
          onSelect={onSelect}
          view={view}
        />
      </ToolSection>
    </div>
  )
}

/**
 * Visible only in print output. The browser's print header strips the
 * page chrome and we want the printed PDF to have its own title block
 * and identify which entity's ranks are being shown.
 */
function PrintHeader({
  keyword,
  target,
  viewTitle,
}: {
  keyword: string
  target: Target
  viewTitle: string
}) {
  return (
    <div className="hidden print:block">
      <h1 className="font-sans text-[20px] font-bold text-foreground">
        GBP Heatmap — {viewTitle}
      </h1>
      <p className="font-mono text-[10.5px] text-ink-3">
        Keyword: <strong>{keyword || "—"}</strong> · Scanned business:{" "}
        <strong>{target.title}</strong> · Generated{" "}
        {new Date().toLocaleString()}
      </p>
    </div>
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

type View = {
  kind: "target" | "competitor"
  title: string
  address: string | null
  rating: number | null
  rating_count: number | null
  category: string | null
  lat: number
  lng: number
  place_id: string | null
  ranks: (number | null)[]
  appearances: number
  kpis: Kpis
}

function EntityCard({ view }: { view: View }) {
  return (
    <div className="rounded-xl border border-line bg-card px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 font-sans text-[14px] font-semibold text-foreground">
            {view.title}
            {view.kind === "target" ? (
              <Badge variant="default">You</Badge>
            ) : (
              <Badge variant="secondary">Competitor</Badge>
            )}
          </p>
          {view.address ? (
            <p className="mt-1 inline-flex items-center gap-1.5 font-mono text-[11px] text-ink-3">
              <MapPin className="h-3 w-3" /> {view.address}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-4 text-[11.5px] text-ink-2">
          {view.rating != null ? (
            <span className="inline-flex items-center gap-1">
              <Star className="h-3.5 w-3.5 fill-amber-400 stroke-amber-500" />
              {view.rating.toFixed(1)}
              {view.rating_count != null ? ` · ${view.rating_count}` : ""}
            </span>
          ) : null}
          {view.category ? <span>{view.category}</span> : null}
          <span className="font-mono text-[10.5px] text-ink-3">
            {view.lat.toFixed(5)}, {view.lng.toFixed(5)}
          </span>
        </div>
      </div>
    </div>
  )
}

function KpiGrid({ kpis }: { kpis: Kpis }) {
  const items = [
    {
      label: "Avg rank",
      value: kpis.avg_rank == null ? "—" : kpis.avg_rank.toFixed(1),
      color: undefined as string | undefined,
      sub: undefined as string | undefined,
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
  targetRanks,
  selected,
  onSelect,
  view,
}: {
  grid: NonNullable<Data["grid"]>
  competitors: Competitor[]
  target: Target
  targetRanks: (number | null)[]
  selected: SelectedKey
  onSelect: (s: SelectedKey) => void
  view: View
}) {
  const totalPoints = grid.points.length
  const targetAvgRank = useMemo(() => {
    const nums = targetRanks.filter((r): r is number => typeof r === "number")
    return nums.length > 0
      ? nums.reduce((a, b) => a + b, 0) / nums.length
      : null
  }, [targetRanks])
  const mapConfigured = isGoogleMapsConfigured()

  return (
    <div className="rounded-xl border border-line bg-card">
      <div className="grid grid-cols-1 md:grid-cols-[220px_1fr]">
        <CompetitorSidebar
          competitors={competitors}
          target={target}
          targetAvgRank={targetAvgRank}
          totalPoints={totalPoints}
          selected={selected}
          onSelect={onSelect}
        />
        <div className="border-t border-line p-4 md:border-l md:border-t-0">
          {/* Screen view: Google Maps (when configured), with SVG hidden. */}
          {mapConfigured ? (
            <div className="print:hidden">
              <HeatmapMap
                grid={grid}
                ranks={view.ranks}
                markerLat={view.lat}
                markerLng={view.lng}
                markerTitle={view.title}
              />
            </div>
          ) : (
            <div className="print:hidden">
              <MapSetupBanner />
              <HeatmapGrid grid={grid} ranks={view.ranks} />
            </div>
          )}
          {/* Print view: always use the SVG grid so the PDF renders
              deterministically without depending on Google Maps tile
              loading state. */}
          <div className="hidden print:block">
            <HeatmapGrid grid={grid} ranks={view.ranks} />
          </div>
          <Legend />
        </div>
      </div>
    </div>
  )
}

function MapSetupBanner() {
  return (
    <div className="mb-3 rounded-md border border-amber-300/60 bg-amber-50/60 px-3 py-2 font-mono text-[11px] text-amber-900">
      Set <code>NEXT_PUBLIC_GOOGLE_MAPS_API_KEY</code> in Vercel env vars to
      overlay the grid on a real Google Map. Showing schematic grid instead.
    </div>
  )
}

function CompetitorSidebar({
  competitors,
  target,
  targetAvgRank,
  totalPoints,
  selected,
  onSelect,
}: {
  competitors: Competitor[]
  target: Target
  targetAvgRank: number | null
  totalPoints: number
  selected: SelectedKey
  onSelect: (s: SelectedKey) => void
}) {
  const isTargetSelected = selected === "target"
  return (
    <div className="p-3.5">
      <p className="mb-2.5 font-sans text-[10.5px] uppercase tracking-[0.08em] text-ink-3">
        Businesses
      </p>
      <ul className="space-y-1">
        <li>
          <button
            type="button"
            onClick={() => onSelect("target")}
            className={cn(
              "w-full rounded-md px-2 py-2 text-left transition-colors",
              isTargetSelected
                ? "border-l-[3px] border-l-[#0F6E56] bg-muted/60 pl-[5px]"
                : "hover:bg-muted/40",
            )}
          >
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
          </button>
        </li>
        {competitors.map((c, i) => {
          const key = competitorKey(c)
          const isSelected = selected === key
          const canSelect = c.lat != null && c.lng != null
          return (
            <li key={`${key}-${i}`}>
              <button
                type="button"
                onClick={() => onSelect(key)}
                disabled={!canSelect}
                title={
                  canSelect
                    ? "Show this competitor's heatmap"
                    : "No coordinates available for this competitor"
                }
                className={cn(
                  "w-full rounded-md px-2 py-2 text-left transition-colors",
                  isSelected
                    ? "border-l-[3px] border-l-[#0F6E56] bg-muted/60 pl-[5px]"
                    : "hover:bg-muted/40",
                  !canSelect && "opacity-60",
                )}
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
              </button>
            </li>
          )
        })}
        {competitors.length === 0 ? (
          <li className="font-serif text-[11px] text-ink-3">
            No competitors found across the grid.
          </li>
        ) : null}
      </ul>
    </div>
  )
}

function HeatmapGrid({
  grid,
  ranks,
}: {
  grid: NonNullable<Data["grid"]>
  ranks: (number | null)[]
}) {
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
      {points.map((p, i) => {
        const cx = padding + p.col * cellSize
        const cy = padding + p.row * cellSize
        const isCenter = p.row === targetRow && p.col === targetCol
        const rank = ranks[i] ?? null
        const fill = rankColor(rank)
        const r = isCenter ? 17 : 15
        const text = rank == null ? "—" : String(rank)
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
