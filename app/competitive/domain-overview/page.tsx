"use client"

import { useMemo, useState, type FormEvent } from "react"
import { Download, Loader2 } from "lucide-react"
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
  organicKeywords: number
  organicTraffic: number
  backlinks: number
  referringDomains: number
  rank: number
  serpFeatures: number
}

type PositionDistribution = {
  top3: number
  p4_10: number
  p11_20: number
  p21_50: number
  p51_100: number
  total: number
}

type PositionChanges = {
  isNew: number
  isLost: number
  isUp: number
  isDown: number
}

type TrafficPoint = { label: string; etv: number }

type TopKeyword = {
  keyword: string
  position: number
  volume: number
  traffic: number
  url: string
}

type Competitor = { domain: string; intersections: number }

type BacklinkProfile = {
  total: number
  dofollowPct: number | null
  new30d: number
  lost30d: number
}

type CitySerpRow = {
  keyword: string
  positions: Record<string, number | null>
}

type RawEnvelopes = {
  generatedAt: string
  target: string
  market: string
  envelopes: Record<string, unknown>
}

type Data = {
  target: string
  market: string
  cities: string[]
  kpis: Kpis
  positionDistribution: PositionDistribution
  positionChanges: PositionChanges
  trafficTrend: TrafficPoint[]
  topKeywords: TopKeyword[]
  competitors: Competitor[]
  backlinkProfile: BacklinkProfile
  citySerp: CitySerpRow[]
  _raw: RawEnvelopes
}

const POS_BAND_COLORS = {
  top3: "#0F6E56",
  p4_10: "#1D9E75",
  p11_20: "#5DCAA5",
  p21_50: "#EF9F27",
  p51_100: "#FAC775",
} as const

export default function DomainOverviewPage() {
  const tool = findToolByPathname("/competitive/domain-overview")!
  const [target, setTarget] = useState("")
  const [cities, setCities] = useState<DfsLabsLocation[]>([])
  const { data, meta, loading, error, run, setError } = useToolRun<Data>(
    "/api/tools/competitive/domain-overview",
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
      prev.some((p) => p.location_code === loc.location_code) ? prev : [...prev, loc],
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
      save={{
        kind: "domain_overview",
        enabled: data != null,
        getDefaultTitle: () => `${target || "Domain"} — Overview`,
        getData: () => ({
          target,
          capturedAt: new Date().toISOString(),
          ...data,
        }),
      }}
      form={
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_auto] md:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="target">Target domain</Label>
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
              Run Overview
            </Button>
          </div>
          <LocationAutocomplete
            inputId="city-serp-locations"
            label="City SERP positions (optional)"
            helpText="Pick city-level locations from the DataForSEO taxonomy. One paid SERP call per (top-5 keyword × city)."
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
        Enter a target domain and run the overview to populate the dashboard.
      </p>
    </div>
  )
}

function Results({ data }: { data: Data }) {
  return (
    <div className="space-y-3.5">
      <div className="flex items-center justify-between">
        <p className="font-mono text-[11px] text-ink-3">
          Target: <span className="text-foreground">{data.target}</span>
        </p>
        <DownloadRawButton raw={data._raw} target={data.target} />
      </div>
      <KpiRow kpis={data.kpis} />
      <SourceLine>domain_rank_overview · backlinks/summary</SourceLine>

      <SectionCard>
        <SectionHeader>Position distribution</SectionHeader>
        <PositionDistributionBar dist={data.positionDistribution} />
        <Source>
          domain_rank_overview · pos_1, pos_2_3, pos_4_10, pos_11_20, pos_21_30 …
          pos_91_100
        </Source>
      </SectionCard>

      <PositionChangesRow changes={data.positionChanges} />
      <SourceLine>historical_rank_overview · current vs previous period diff</SourceLine>

      <SectionCard>
        <SectionHeader>Organic traffic trend · 12 months</SectionHeader>
        <TrafficTrendChart series={data.trafficTrend} />
        <Source>historical_rank_overview · monthly etv buckets</Source>
      </SectionCard>

      <SectionCard>
        <SectionHeader>Top organic keywords</SectionHeader>
        <TopKeywordsTable rows={data.topKeywords} />
        <Source>ranked_keywords · relevant_pages</Source>
      </SectionCard>

      <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
        <SectionCard className="mb-0">
          <SectionHeader>Top competitors</SectionHeader>
          <CompetitorsTable rows={data.competitors} />
          <Source>competitors_domain</Source>
        </SectionCard>
        <SectionCard className="mb-0">
          <SectionHeader>Backlink profile</SectionHeader>
          <BacklinkProfileGrid profile={data.backlinkProfile} />
          <Source>backlinks/summary · timeseries_new_lost_summary</Source>
        </SectionCard>
      </div>

      <SectionCard>
        <SectionHeader>
          City SERP positions{" "}
          <span className="text-ink-3 font-normal text-[12px] ml-1.5">
            tracked keywords × city
          </span>
        </SectionHeader>
        <CitySerpTable rows={data.citySerp} cities={data.cities} />
        <Source>
          serp/google/organic/live/advanced · one call per keyword × city
        </Source>
      </SectionCard>
    </div>
  )
}

// ─── small layout primitives ─────────────────────────────────────────────

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

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-sans text-[13px] font-semibold text-foreground mb-3">
      {children}
    </p>
  )
}

function Source({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-mono text-[11px] text-ink-3 mt-3">{children}</p>
  )
}

function SourceLine({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-mono text-[11px] text-ink-3 -mt-2 mb-3">{children}</p>
  )
}

// ─── KPI cards ──────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  delta,
  deltaTone,
}: {
  label: string
  value: string
  delta?: string
  deltaTone?: "success" | "danger" | "neutral"
}) {
  const tone =
    deltaTone === "success"
      ? "text-success"
      : deltaTone === "danger"
        ? "text-destructive"
        : "text-ink-3"
  return (
    <div className="rounded-md bg-muted/40 px-4 py-3.5 flex flex-col gap-[3px]">
      <span className="text-[13px] text-ink-2">{label}</span>
      <span className="text-[22px] leading-[1.1] font-medium text-foreground tabular-nums">
        {value}
      </span>
      {delta ? (
        <span className={cn("text-[11px] mt-0.5", tone)}>{delta}</span>
      ) : null}
    </div>
  )
}

function KpiRow({ kpis }: { kpis: Kpis }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5">
      <KpiCard
        label="Organic keywords"
        value={kpis.organicKeywords.toLocaleString()}
      />
      <KpiCard
        label="Organic traffic"
        value={formatCompact(kpis.organicTraffic)}
        delta="est. monthly"
      />
      <KpiCard
        label="Backlinks"
        value={kpis.backlinks.toLocaleString()}
        delta={`${kpis.referringDomains.toLocaleString()} ref. domains`}
      />
      <KpiCard
        label="DFSEO rank"
        value={kpis.rank.toLocaleString()}
        delta="0–1000 scale"
      />
      <KpiCard
        label="SERP features"
        value={kpis.serpFeatures.toLocaleString()}
        delta="types ranking"
      />
    </div>
  )
}

function PositionChangesRow({ changes }: { changes: PositionChanges }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
      <ChangeCard label="New keywords" value={changes.isNew} positive />
      <ChangeCard label="Lost" value={changes.isLost} positive={false} />
      <ChangeCard label="Improved" value={changes.isUp} positive />
      <ChangeCard label="Declined" value={changes.isDown} positive={false} />
    </div>
  )
}

function ChangeCard({
  label,
  value,
  positive,
}: {
  label: string
  value: number
  positive: boolean
}) {
  const sign = value === 0 ? "" : positive ? "+" : "-"
  return (
    <div className="rounded-md bg-muted/40 px-4 py-3.5 flex flex-col gap-[3px]">
      <span className="text-[13px] text-ink-2">{label}</span>
      <span
        className={cn(
          "text-[22px] leading-[1.1] font-medium tabular-nums",
          value === 0
            ? "text-foreground"
            : positive
              ? "text-success"
              : "text-destructive",
        )}
      >
        {sign}
        {Math.abs(value).toLocaleString()}
      </span>
    </div>
  )
}

// ─── Position distribution bar ──────────────────────────────────────────

function PositionDistributionBar({ dist }: { dist: PositionDistribution }) {
  const total = Math.max(dist.total, 1)
  const bands = [
    { key: "top3", label: "Top 3", count: dist.top3 },
    { key: "p4_10", label: "4–10", count: dist.p4_10 },
    { key: "p11_20", label: "11–20", count: dist.p11_20 },
    { key: "p21_50", label: "21–50", count: dist.p21_50 },
    { key: "p51_100", label: "51–100", count: dist.p51_100 },
  ] as const

  return (
    <div>
      <div className="flex w-full h-7 rounded-md overflow-hidden">
        {bands.map((b) =>
          b.count > 0 ? (
            <div
              key={b.key}
              title={`${b.label}: ${b.count.toLocaleString()}`}
              style={{
                width: `${(b.count / total) * 100}%`,
                background: POS_BAND_COLORS[b.key],
              }}
            />
          ) : null,
        )}
      </div>
      <div className="flex flex-wrap gap-4 mt-3.5 text-[12px] text-ink-2">
        {bands.map((b) => (
          <span key={b.key} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block w-2.5 h-2.5 rounded-[2px]"
              style={{ background: POS_BAND_COLORS[b.key] }}
            />
            {b.label} ·{" "}
            <span className="font-medium text-foreground tabular-nums">
              {b.count.toLocaleString()}
            </span>
          </span>
        ))}
      </div>
    </div>
  )
}

// ─── Traffic trend line chart (hand-rolled SVG) ─────────────────────────
// Pure-SVG line chart to keep this self-contained. Matches the existing
// hand-rolled chart style used in components/audit-dashboard/TrafficChart.
const TRAFFIC_WIDTH = 720
const TRAFFIC_HEIGHT = 200
const TRAFFIC_PAD = { top: 12, right: 12, bottom: 28, left: 44 } as const

function TrafficTrendChart({ series }: { series: TrafficPoint[] }) {
  const { path, area, points, maxY, minY, xs, ys } = useMemo(() => {
    if (series.length === 0) {
      return {
        path: "",
        area: "",
        points: [] as { x: number; y: number; etv: number }[],
        maxY: 0,
        minY: 0,
        xs: [] as number[],
        ys: [] as number[],
      }
    }
    const innerW = TRAFFIC_WIDTH - TRAFFIC_PAD.left - TRAFFIC_PAD.right
    const innerH = TRAFFIC_HEIGHT - TRAFFIC_PAD.top - TRAFFIC_PAD.bottom
    const values = series.map((p) => p.etv)
    const maxYRaw = Math.max(1, ...values)
    const minYRaw = Math.min(...values)
    const pad = Math.max(1, (maxYRaw - minYRaw) * 0.1)
    const maxY = maxYRaw + pad
    const minY = Math.max(0, minYRaw - pad)
    const step = series.length > 1 ? innerW / (series.length - 1) : 0
    const xs = series.map((_, i) => TRAFFIC_PAD.left + step * i)
    const yFor = (v: number) =>
      TRAFFIC_PAD.top +
      innerH -
      ((v - minY) / Math.max(1, maxY - minY)) * innerH
    const ys = values.map(yFor)
    const path = series
      .map((_, i) => `${i === 0 ? "M" : "L"} ${xs[i]} ${ys[i]}`)
      .join(" ")
    const area =
      path && series.length > 1
        ? `${path} L ${xs[xs.length - 1]} ${TRAFFIC_PAD.top + innerH} L ${xs[0]} ${TRAFFIC_PAD.top + innerH} Z`
        : ""
    const points = series.map((p, i) => ({ x: xs[i], y: ys[i], etv: p.etv }))
    return { path, area, points, maxY, minY, xs, ys }
  }, [series])

  if (series.length === 0) {
    return (
      <p className="font-serif text-sm italic text-ink-3">
        No historical traffic data available.
      </p>
    )
  }

  const ticks = 4
  const tickValues = Array.from({ length: ticks + 1 }, (_, i) =>
    Math.round(minY + ((maxY - minY) / ticks) * i),
  )
  const innerH = TRAFFIC_HEIGHT - TRAFFIC_PAD.top - TRAFFIC_PAD.bottom
  const yForTick = (v: number) =>
    TRAFFIC_PAD.top +
    innerH -
    ((v - minY) / Math.max(1, maxY - minY)) * innerH

  return (
    <div className="w-full">
      <svg
        viewBox={`0 0 ${TRAFFIC_WIDTH} ${TRAFFIC_HEIGHT}`}
        width="100%"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Organic traffic trend, last 12 months"
        className="block"
      >
        {tickValues.map((t, i) => {
          const y = yForTick(t)
          return (
            <g key={i}>
              <line
                x1={TRAFFIC_PAD.left}
                x2={TRAFFIC_WIDTH - TRAFFIC_PAD.right}
                y1={y}
                y2={y}
                stroke="var(--line)"
                strokeWidth={1}
              />
              <text
                x={TRAFFIC_PAD.left - 8}
                y={y + 3}
                textAnchor="end"
                fontFamily="var(--font-sans, system-ui)"
                fontSize="10"
                fill="var(--ink-3)"
              >
                {formatCompact(t)}
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
              y={TRAFFIC_HEIGHT - TRAFFIC_PAD.bottom + 14}
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
      {/* `ys` is referenced indirectly via points; keep it in the deps */}
      <span className="sr-only">{ys.length} points</span>
    </div>
  )
}

// ─── Tables ──────────────────────────────────────────────────────────────

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

function TopKeywordsTable({ rows }: { rows: TopKeyword[] }) {
  if (rows.length === 0) {
    return (
      <p className="font-serif text-sm italic text-ink-3">
        No ranked keywords returned.
      </p>
    )
  }
  return (
    <CompactTable>
      <thead>
        <tr>
          <th className={TH_CLS}>Keyword</th>
          <th className={cn(TH_CLS, "text-right")}>Pos</th>
          <th className={cn(TH_CLS, "text-right")}>Volume</th>
          <th className={cn(TH_CLS, "text-right")}>Est. traffic</th>
          <th className={TH_CLS}>Ranking URL</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.keyword}>
            <td className={TD_CLS}>{r.keyword}</td>
            <td className={cn(TD_CLS, "text-right tabular-nums")}>{r.position}</td>
            <td className={cn(TD_CLS, "text-right tabular-nums")}>
              {r.volume.toLocaleString()}
            </td>
            <td className={cn(TD_CLS, "text-right tabular-nums")}>
              {r.traffic.toLocaleString()}
            </td>
            <td
              className={cn(
                TD_CLS,
                "text-ink-2 text-[11px] truncate max-w-[260px]",
              )}
              title={r.url}
            >
              {r.url || "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </CompactTable>
  )
}

function CompetitorsTable({ rows }: { rows: Competitor[] }) {
  if (rows.length === 0) {
    return (
      <p className="font-serif text-sm italic text-ink-3">
        No competitors returned.
      </p>
    )
  }
  return (
    <CompactTable>
      <thead>
        <tr>
          <th className={TH_CLS}>Domain</th>
          <th className={cn(TH_CLS, "text-right")}>Shared kw</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.domain}>
            <td className={TD_CLS}>{r.domain}</td>
            <td className={cn(TD_CLS, "text-right tabular-nums")}>
              {r.intersections.toLocaleString()}
            </td>
          </tr>
        ))}
      </tbody>
    </CompactTable>
  )
}

function CitySerpTable({
  rows,
  cities,
}: {
  rows: CitySerpRow[]
  cities: string[]
}) {
  if (rows.length === 0 || cities.length === 0) {
    return (
      <p className="font-serif text-sm italic text-ink-3">
        Add a comma-separated list of cities above (e.g. &ldquo;Orlando, Sunrise,
        Palm Coast&rdquo;) to populate this matrix. One paid SERP call per
        keyword × city.
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
              const v = r.positions[c]
              return (
                <td
                  key={c}
                  className={cn(TD_CLS, "text-right tabular-nums")}
                  title={v == null ? "Not in top 100" : `Position ${v}`}
                >
                  {v == null ? "—" : v}
                </td>
              )
            })}
          </tr>
        ))}
      </tbody>
    </CompactTable>
  )
}

function BacklinkProfileGrid({ profile }: { profile: BacklinkProfile }) {
  return (
    <div className="grid grid-cols-2 gap-3.5 mb-1">
      <BacklinkMini label="Total" value={profile.total.toLocaleString()} />
      <BacklinkMini
        label="Dofollow"
        value={
          profile.dofollowPct == null
            ? "—"
            : `${Math.round(profile.dofollowPct)}%`
        }
      />
      <BacklinkMini
        label="New (30d)"
        value={`+${profile.new30d.toLocaleString()}`}
        tone="success"
      />
      <BacklinkMini
        label="Lost (30d)"
        value={`-${profile.lost30d.toLocaleString()}`}
        tone="danger"
      />
    </div>
  )
}

function BacklinkMini({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: "success" | "danger"
}) {
  const toneCls =
    tone === "success"
      ? "text-success"
      : tone === "danger"
        ? "text-destructive"
        : "text-foreground"
  return (
    <div>
      <p className="text-[12px] text-ink-2 mb-0.5">{label}</p>
      <p className={cn("text-[18px] font-medium tabular-nums", toneCls)}>
        {value}
      </p>
    </div>
  )
}

function DownloadRawButton({
  raw,
  target,
}: {
  raw: RawEnvelopes
  target: string
}) {
  const handleDownload = () => {
    const blob = new Blob([JSON.stringify(raw, null, 2)], {
      type: "application/json",
    })
    const url = URL.createObjectURL(blob)
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19)
    const safeTarget = target.replace(/[^a-z0-9.-]+/gi, "-")
    const a = document.createElement("a")
    a.href = url
    a.download = `domain-overview-${safeTarget}-${stamp}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={handleDownload}
      className="h-8"
      title="Download every DataForSEO envelope returned during this run"
    >
      <Download className="mr-1.5 h-3.5 w-3.5" />
      Download raw JSON
    </Button>
  )
}

// ─── helpers ─────────────────────────────────────────────────────────────

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1_000)}K`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}
