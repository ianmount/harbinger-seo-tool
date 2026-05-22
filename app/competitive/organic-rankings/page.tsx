"use client"

import { useMemo, useState, type FormEvent } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { LocationAutocomplete } from "@/components/LocationAutocomplete"
import { ToolShell } from "@/components/tool/ToolShell"
import { ToolError, useToolRun } from "@/components/tool/use-tool-run"
import { findToolByPathname } from "@/lib/tool-config"
import { cn } from "@/lib/utils"
import type { DfsLabsLocation } from "@/lib/types"

type Kpis = {
  visibilityScore: number
  trackedKeywords: number
  cityCount: number
  avgPosition: number | null
  trafficValueUsd: number
  serpFeatures: number
}

type TrendPoint = { label: string; visibility: number }

type Mover = { keyword: string; from: number | null; to: number; delta: number }

type SerpFeatureRow = { type: string; label: string; count: number }

type IntentRow = { intent: string; count: number; pct: number }

type PageRow = {
  url: string
  keywords: number
  etv: number
  topKeyword: string | null
}

type KeywordRow = {
  keyword: string
  position: number
  delta: number | null
  volume: number | null
  kd: number | null
  intent: string | null
  url: string
}

type CitySerpRow = {
  keyword: string
  positions: Record<string, { pos: number | null; delta: number | null }>
}

type Data = {
  target: string
  market: string
  cities: string[]
  kpis: Kpis
  visibilityTrend: TrendPoint[]
  topGainers: Mover[]
  topLosers: Mover[]
  serpFeatures: SerpFeatureRow[]
  intent: IntentRow[]
  pages: PageRow[]
  keywords: KeywordRow[]
  citySerp: CitySerpRow[]
}

const INTENT_COLORS: Record<string, string> = {
  informational: "#9FE1CB",
  navigational: "#5DCAA5",
  commercial: "#1D9E75",
  transactional: "#0F6E56",
}
const INTENT_LABELS: Record<string, string> = {
  informational: "Informational",
  navigational: "Navigational",
  commercial: "Commercial",
  transactional: "Transactional",
}
const INTENT_CODE: Record<string, string> = {
  informational: "I",
  navigational: "N",
  commercial: "C",
  transactional: "T",
}

export default function OrganicRankingsPage() {
  const tool = findToolByPathname("/competitive/organic-rankings")!
  const [target, setTarget] = useState("")
  const [cities, setCities] = useState<DfsLabsLocation[]>([])
  const { data, meta, loading, error, run, setError } = useToolRun<Data>(
    "/api/tools/competitive/organic-rankings",
  )

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!target.trim()) {
      setError("Enter a domain.")
      return
    }
    await run({
      target: target.trim(),
      cities: cities.map((c) => ({
        location_code: c.location_code,
        location_name: c.location_name,
      })),
    })
  }

  const handleAddCity = (loc: DfsLabsLocation) =>
    setCities((prev) =>
      prev.some((p) => p.location_code === loc.location_code)
        ? prev
        : [...prev, loc],
    )
  const handleRemoveCity = (code: number) =>
    setCities((prev) => prev.filter((p) => p.location_code !== code))

  return (
    <ToolShell
      category="Analysis"
      title={tool.label}
      description={tool.description}
      endpoints={tool.endpoints}
      meta={meta}
      form={
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_auto] md:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="target">Domain</Label>
              <Input
                id="target"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="example.com"
                disabled={loading}
              />
            </div>
            <Button type="submit" disabled={loading}>
              {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Pull Rankings
            </Button>
          </div>
          <LocationAutocomplete
            inputId="organic-rankings-cities"
            label="City rankings (optional)"
            helpText="Pick city-level locations from DataForSEO's taxonomy. One live SERP call per top-5 keyword × city."
            selected={cities}
            onAdd={handleAddCity}
            onRemove={handleRemoveCity}
            disabled={loading}
          />
        </form>
      }
      results={
        error ? (
          <ToolError message={error} />
        ) : data ? (
          <Results data={data} />
        ) : (
          <EmptyState />
        )
      }
    />
  )
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-dashed border-line bg-muted/30 px-6 py-10 text-center">
      <p className="font-serif text-[13.5px] text-ink-3">
        Enter a domain and run the dashboard to populate organic rankings.
      </p>
    </div>
  )
}

function Results({ data }: { data: Data }) {
  return (
    <div className="space-y-3.5">
      <p className="font-mono text-[11px] text-ink-3">
        Target: <span className="text-foreground">{data.target}</span>
      </p>

      <KpiRow kpis={data.kpis} />
      <SourceLine>
        ranked_keywords (aggregated) · historical_rank_overview · derived
        visibility score
      </SourceLine>

      <SectionCard>
        <SectionHeader>Visibility trend · 12 months</SectionHeader>
        <VisibilityTrendChart series={data.visibilityTrend} />
        <Source>
          historical_rank_overview · weighted sum of (ctr_by_position × volume)
          ÷ max
        </Source>
      </SectionCard>

      <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
        <SectionCard className="mb-0">
          <SectionHeader tone="success">Top gainers</SectionHeader>
          <MoversTable rows={data.topGainers} positive />
          <Source>ranked_keywords · rank_changes.previous_rank_absolute diff</Source>
        </SectionCard>
        <SectionCard className="mb-0">
          <SectionHeader tone="danger">Top losers</SectionHeader>
          <MoversTable rows={data.topLosers} positive={false} />
          <Source>ranked_keywords · rank_changes.previous_rank_absolute diff</Source>
        </SectionCard>
      </div>

      <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
        <SectionCard className="mb-0">
          <SectionHeader>SERP features owned</SectionHeader>
          <SerpFeaturesList rows={data.serpFeatures} />
          <Source>ranked_keywords · serp_item.type</Source>
        </SectionCard>
        <SectionCard className="mb-0">
          <SectionHeader>Keyword intent breakdown</SectionHeader>
          <IntentBreakdown rows={data.intent} />
          <Source>search_intent · per-keyword classification</Source>
        </SectionCard>
      </div>

      <SectionCard>
        <SectionHeader>Pages report</SectionHeader>
        <PagesTable rows={data.pages} />
        <Source>relevant_pages · sorted by est. traffic desc</Source>
      </SectionCard>

      <SectionCard>
        <SectionHeader>
          Keyword table{" "}
          <span className="text-ink-3 font-normal text-[12px] ml-1.5">
            filterable: intent, pos range, vol range
          </span>
        </SectionHeader>
        <KeywordsTable rows={data.keywords} />
        <Source>
          ranked_keywords · joined with search_intent for intent column ·
          rank_changes for Δ
        </Source>
      </SectionCard>

      <SectionCard>
        <SectionHeader>
          City rankings{" "}
          <span className="text-ink-3 font-normal text-[12px] ml-1.5">
            cycle-over-cycle delta
          </span>
        </SectionHeader>
        <CitySerpTable rows={data.citySerp} cities={data.cities} />
        <Source>
          serp/google/organic/live/advanced · per keyword × city · previous
          cycle snapshot not yet persisted
        </Source>
      </SectionCard>
    </div>
  )
}

// ─── Layout primitives ───────────────────────────────────────────────────

function SectionCard({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <section
      className={cn(
        "rounded-xl border border-line bg-card px-5 py-4 mb-3.5",
        className,
      )}
    >
      {children}
    </section>
  )
}

function SectionHeader({
  children,
  tone,
}: {
  children: React.ReactNode
  tone?: "success" | "danger"
}) {
  const dot =
    tone === "success"
      ? "before:bg-success"
      : tone === "danger"
        ? "before:bg-destructive"
        : "before:hidden"
  return (
    <p
      className={cn(
        "font-sans text-[13px] font-semibold text-foreground mb-3 inline-flex items-center gap-2",
        "before:content-[''] before:inline-block before:h-2 before:w-2 before:rounded-full",
        dot,
      )}
    >
      {children}
    </p>
  )
}

function Source({ children }: { children: React.ReactNode }) {
  return <p className="font-mono text-[11px] text-ink-3 mt-3">{children}</p>
}

function SourceLine({ children }: { children: React.ReactNode }) {
  return <p className="font-mono text-[11px] text-ink-3 -mt-2 mb-3">{children}</p>
}

// ─── KPI row ─────────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  delta,
}: {
  label: string
  value: string
  delta?: string
}) {
  return (
    <div className="rounded-md bg-muted/40 px-4 py-3.5 flex flex-col gap-[3px]">
      <span className="text-[13px] text-ink-2">{label}</span>
      <span className="text-[22px] leading-[1.1] font-medium text-foreground tabular-nums">
        {value}
      </span>
      {delta ? (
        <span className="text-[11px] text-ink-3 mt-0.5">{delta}</span>
      ) : null}
    </div>
  )
}

function KpiRow({ kpis }: { kpis: Kpis }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5">
      <KpiCard
        label="Visibility score"
        value={`${kpis.visibilityScore.toFixed(1)}%`}
        delta="share of clicks for tracked kw"
      />
      <KpiCard
        label="Tracked keywords"
        value={kpis.trackedKeywords.toLocaleString()}
        delta={
          kpis.cityCount > 0
            ? `across ${kpis.cityCount} cit${kpis.cityCount === 1 ? "y" : "ies"}`
            : "country-level"
        }
      />
      <KpiCard
        label="Avg position"
        value={kpis.avgPosition == null ? "—" : kpis.avgPosition.toFixed(1)}
        delta="mean rank_absolute"
      />
      <KpiCard
        label="Traffic value"
        value={`$${kpis.trafficValueUsd.toLocaleString()}`}
        delta="est. monthly (etv × cpc)"
      />
      <KpiCard
        label="SERP features"
        value={kpis.serpFeatures.toLocaleString()}
        delta="total placements"
      />
    </div>
  )
}

// ─── Visibility trend (hand-rolled SVG line chart) ───────────────────────

const TREND_W = 720
const TREND_H = 200
const TREND_PAD = { top: 12, right: 12, bottom: 28, left: 44 } as const

function VisibilityTrendChart({ series }: { series: TrendPoint[] }) {
  const { path, area, points, maxY, minY, xs, ys } = useMemo(() => {
    if (series.length === 0) {
      return {
        path: "",
        area: "",
        points: [] as { x: number; y: number; v: number }[],
        maxY: 0,
        minY: 0,
        xs: [] as number[],
        ys: [] as number[],
      }
    }
    const innerW = TREND_W - TREND_PAD.left - TREND_PAD.right
    const innerH = TREND_H - TREND_PAD.top - TREND_PAD.bottom
    const values = series.map((p) => p.visibility)
    const maxYRaw = Math.max(0.01, ...values)
    const minYRaw = Math.min(...values)
    const pad = Math.max(0.5, (maxYRaw - minYRaw) * 0.1)
    const maxY = maxYRaw + pad
    const minY = Math.max(0, minYRaw - pad)
    const step = series.length > 1 ? innerW / (series.length - 1) : 0
    const xs = series.map((_, i) => TREND_PAD.left + step * i)
    const yFor = (v: number) =>
      TREND_PAD.top +
      innerH -
      ((v - minY) / Math.max(0.01, maxY - minY)) * innerH
    const ys = values.map(yFor)
    const path = series
      .map((_, i) => `${i === 0 ? "M" : "L"} ${xs[i]} ${ys[i]}`)
      .join(" ")
    const area =
      path && series.length > 1
        ? `${path} L ${xs[xs.length - 1]} ${TREND_PAD.top + innerH} L ${xs[0]} ${TREND_PAD.top + innerH} Z`
        : ""
    const points = series.map((p, i) => ({
      x: xs[i],
      y: ys[i],
      v: p.visibility,
    }))
    return { path, area, points, maxY, minY, xs, ys }
  }, [series])

  if (series.length === 0) {
    return (
      <p className="font-serif text-sm italic text-ink-3">
        No historical data returned.
      </p>
    )
  }

  const ticks = 4
  const tickValues = Array.from({ length: ticks + 1 }, (_, i) =>
    minY + ((maxY - minY) / ticks) * i,
  )
  const innerH = TREND_H - TREND_PAD.top - TREND_PAD.bottom
  const yForTick = (v: number) =>
    TREND_PAD.top +
    innerH -
    ((v - minY) / Math.max(0.01, maxY - minY)) * innerH

  return (
    <div className="w-full">
      <svg
        viewBox={`0 0 ${TREND_W} ${TREND_H}`}
        width="100%"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Visibility trend, last 12 months"
        className="block"
      >
        {tickValues.map((t, i) => {
          const y = yForTick(t)
          return (
            <g key={i}>
              <line
                x1={TREND_PAD.left}
                x2={TREND_W - TREND_PAD.right}
                y1={y}
                y2={y}
                stroke="var(--line)"
                strokeWidth={1}
              />
              <text
                x={TREND_PAD.left - 8}
                y={y + 3}
                textAnchor="end"
                fontFamily="var(--font-sans, system-ui)"
                fontSize="10"
                fill="var(--ink-3)"
              >
                {t.toFixed(1)}%
              </text>
            </g>
          )
        })}
        {area ? <path d={area} fill="rgba(29, 158, 117, 0.08)" /> : null}
        <path
          d={path}
          fill="none"
          stroke="#1D9E75"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {points.map((p, i) => (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={3}
            fill="#1D9E75"
            stroke="#FFFFFF"
            strokeWidth={1.25}
          />
        ))}
        {series.map((p, i) => {
          const everyOther = i % Math.max(1, Math.ceil(series.length / 8)) !== 0
          if (everyOther && i !== series.length - 1) return null
          return (
            <text
              key={`x-${i}`}
              x={xs[i]}
              y={TREND_H - TREND_PAD.bottom + 14}
              textAnchor="middle"
              fontFamily="var(--font-sans, system-ui)"
              fontSize="10"
              fill="var(--ink-3)"
            >
              {p.label}
            </text>
          )
        })}
      </svg>
      <span className="sr-only">{ys.length} points</span>
    </div>
  )
}

// ─── Tables and breakdowns ───────────────────────────────────────────────

function CompactTable({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <table className={cn("w-full border-collapse text-[12px]", className)}>
      {children}
    </table>
  )
}

const TH_CLS =
  "text-left font-medium text-ink-2 text-[11px] py-1.5 px-1 border-b border-line"
const TD_CLS = "py-1.5 px-1 border-b border-line"

function MoversTable({ rows, positive }: { rows: Mover[]; positive: boolean }) {
  if (rows.length === 0) {
    return (
      <p className="font-serif text-sm italic text-ink-3">
        No {positive ? "gainers" : "losers"} in this period.
      </p>
    )
  }
  const deltaCls = positive ? "text-success" : "text-destructive"
  return (
    <CompactTable>
      <tbody>
        {rows.map((r) => (
          <tr key={r.keyword}>
            <td className={TD_CLS}>{r.keyword}</td>
            <td className={cn(TD_CLS, "text-right tabular-nums")}>
              <span className="text-ink-3">
                {r.from ?? "—"}→{r.to}
              </span>{" "}
              <span className={cn("font-medium", deltaCls)}>
                {r.delta > 0 ? `+${r.delta}` : r.delta}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </CompactTable>
  )
}

function SerpFeaturesList({ rows }: { rows: SerpFeatureRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="font-serif text-sm italic text-ink-3">
        No non-organic SERP features detected.
      </p>
    )
  }
  const max = Math.max(...rows.map((r) => r.count), 1)
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <div
          key={r.type}
          className="grid items-center gap-2.5 text-[12px]"
          style={{ gridTemplateColumns: "130px 1fr 36px" }}
        >
          <span className="text-ink-2 truncate" title={r.label}>
            {r.label}
          </span>
          <div className="h-3 rounded-md bg-muted/60 overflow-hidden">
            <div
              className="h-full rounded-md"
              style={{
                width: `${(r.count / max) * 100}%`,
                background: "#1D9E75",
              }}
            />
          </div>
          <span className="text-right font-medium text-foreground tabular-nums">
            {r.count.toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  )
}

function IntentBreakdown({ rows }: { rows: IntentRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="font-serif text-sm italic text-ink-3">
        Intent classification unavailable.
      </p>
    )
  }
  return (
    <>
      <div className="flex w-full h-7 rounded-md overflow-hidden mb-3.5">
        {rows.map((r) => (
          <div
            key={r.intent}
            title={`${INTENT_LABELS[r.intent] ?? r.intent}: ${r.count} (${r.pct.toFixed(0)}%)`}
            style={{
              width: `${r.pct}%`,
              background: INTENT_COLORS[r.intent] ?? "#9FE1CB",
            }}
          />
        ))}
      </div>
      <div className="flex flex-col gap-1.5 text-[12px]">
        {rows.map((r) => (
          <span
            key={r.intent}
            className="inline-flex items-center gap-1.5"
          >
            <span
              className="inline-block w-2.5 h-2.5 rounded-[2px]"
              style={{ background: INTENT_COLORS[r.intent] ?? "#9FE1CB" }}
            />
            <span className="text-ink-2">
              {INTENT_LABELS[r.intent] ?? r.intent}
            </span>
            <span className="text-ink-3">·</span>
            <span className="font-medium text-foreground tabular-nums">
              {r.count.toLocaleString()}
            </span>
            <span className="text-ink-3">({r.pct.toFixed(0)}%)</span>
          </span>
        ))}
      </div>
    </>
  )
}

function PagesTable({ rows }: { rows: PageRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="font-serif text-sm italic text-ink-3">
        No pages returned.
      </p>
    )
  }
  return (
    <CompactTable>
      <thead>
        <tr>
          <th className={TH_CLS}>URL</th>
          <th className={cn(TH_CLS, "text-right")}>Keywords</th>
          <th className={cn(TH_CLS, "text-right")}>Est. traffic</th>
          <th className={TH_CLS}>Top keyword</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.url}>
            <td
              className={cn(
                TD_CLS,
                "text-ink-2 font-mono text-[11px] truncate max-w-[280px]",
              )}
              title={r.url}
            >
              {r.url}
            </td>
            <td className={cn(TD_CLS, "text-right tabular-nums")}>
              {r.keywords.toLocaleString()}
            </td>
            <td className={cn(TD_CLS, "text-right tabular-nums")}>
              {r.etv.toLocaleString()}
            </td>
            <td className={TD_CLS}>{r.topKeyword ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </CompactTable>
  )
}

function KeywordsTable({ rows }: { rows: KeywordRow[] }) {
  const [filter, setFilter] = useState("")
  const [intentFilter, setIntentFilter] = useState<string>("all")

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    return rows.filter((r) => {
      if (intentFilter !== "all" && (r.intent ?? "").toLowerCase() !== intentFilter) {
        return false
      }
      if (!needle) return true
      return (
        r.keyword.toLowerCase().includes(needle) ||
        r.url.toLowerCase().includes(needle)
      )
    })
  }, [rows, filter, intentFilter])

  if (rows.length === 0) {
    return (
      <p className="font-serif text-sm italic text-ink-3">
        No ranked keywords returned.
      </p>
    )
  }

  return (
    <>
      <div className="flex flex-wrap gap-2 mb-2.5">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter keyword or URL…"
          className="h-8 w-[260px] text-[12px]"
        />
        <select
          value={intentFilter}
          onChange={(e) => setIntentFilter(e.target.value)}
          className="h-8 rounded-md border border-input bg-transparent px-2 text-[12px]"
        >
          <option value="all">All intents</option>
          <option value="informational">Informational</option>
          <option value="navigational">Navigational</option>
          <option value="commercial">Commercial</option>
          <option value="transactional">Transactional</option>
        </select>
        <span className="ml-auto font-mono text-[11px] text-ink-3 self-center">
          {filtered.length.toLocaleString()} of {rows.length.toLocaleString()}
        </span>
      </div>
      <CompactTable>
        <thead>
          <tr>
            <th className={TH_CLS}>Keyword</th>
            <th className={cn(TH_CLS, "text-right")}>Pos</th>
            <th className={cn(TH_CLS, "text-right")}>Δ</th>
            <th className={cn(TH_CLS, "text-right")}>Vol</th>
            <th className={cn(TH_CLS, "text-right")}>KD</th>
            <th className={TH_CLS}>Intent</th>
            <th className={TH_CLS}>URL</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((r) => (
            <tr key={`${r.keyword}-${r.url}`}>
              <td className={TD_CLS}>{r.keyword}</td>
              <td className={cn(TD_CLS, "text-right tabular-nums font-medium")}>
                {r.position}
              </td>
              <td className={cn(TD_CLS, "text-right tabular-nums")}>
                <DeltaCell delta={r.delta} />
              </td>
              <td className={cn(TD_CLS, "text-right tabular-nums")}>
                {r.volume == null ? "—" : r.volume.toLocaleString()}
              </td>
              <td className={cn(TD_CLS, "text-right tabular-nums")}>
                {r.kd == null ? "—" : r.kd}
              </td>
              <td className={cn(TD_CLS, "text-ink-2 text-[11px]")}>
                {r.intent
                  ? INTENT_CODE[r.intent.toLowerCase()] ?? r.intent[0].toUpperCase()
                  : "—"}
              </td>
              <td
                className={cn(
                  TD_CLS,
                  "text-ink-2 font-mono text-[11px] truncate max-w-[220px]",
                )}
                title={r.url}
              >
                {r.url || "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </CompactTable>
    </>
  )
}

function DeltaCell({ delta }: { delta: number | null }) {
  if (delta == null || delta === 0) {
    return <span className="text-ink-3">—</span>
  }
  const cls = delta > 0 ? "text-success" : "text-destructive"
  return (
    <span className={cn("font-medium", cls)}>
      {delta > 0 ? `+${delta}` : delta}
    </span>
  )
}

function CitySerpTable({
  rows,
  cities,
}: {
  rows: CitySerpRow[]
  cities: string[]
}) {
  if (cities.length === 0) {
    return (
      <p className="font-serif text-sm italic text-ink-3">
        Add cities above (e.g. Orlando, Sunrise, Palm Coast) to populate this
        matrix. One live SERP call per top-5 keyword × city.
      </p>
    )
  }
  if (rows.length === 0) {
    return (
      <p className="font-serif text-sm italic text-ink-3">
        No keywords available for city-level lookups.
      </p>
    )
  }
  return (
    <CompactTable>
      <thead>
        <tr>
          <th className={TH_CLS}>Keyword</th>
          {cities.map((c) => (
            <th key={c} className={cn(TH_CLS, "text-right")}>
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.keyword}>
            <td className={TD_CLS}>{r.keyword}</td>
            {cities.map((c) => {
              const cell = r.positions[c]
              const pos = cell?.pos
              const delta = cell?.delta
              return (
                <td
                  key={c}
                  className={cn(TD_CLS, "text-right tabular-nums")}
                  title={pos == null ? "Not in top 100" : `Position ${pos}`}
                >
                  {pos == null ? (
                    <span className="text-ink-3">—</span>
                  ) : (
                    <>
                      <span className="font-medium text-foreground">{pos}</span>{" "}
                      {delta == null || delta === 0 ? (
                        <span className="text-ink-3 text-[11px]">—</span>
                      ) : (
                        <span
                          className={cn(
                            "text-[11px]",
                            delta > 0 ? "text-success" : "text-destructive",
                          )}
                        >
                          {delta > 0 ? `+${delta}` : delta}
                        </span>
                      )}
                    </>
                  )}
                </td>
              )
            })}
          </tr>
        ))}
      </tbody>
    </CompactTable>
  )
}
