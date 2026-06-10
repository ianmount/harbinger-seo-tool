"use client"

import { useEffect, useMemo, useState, type FormEvent } from "react"
import { Loader2, MapPin, Printer, Star } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { JobsForKindCard } from "@/components/JobsForKindCard"
import { MarketPicker } from "@/components/tool/MarketPicker"
import { ToolShell } from "@/components/tool/ToolShell"
import {
  ToolError,
  ToolSection,
  type ToolRunMeta,
} from "@/components/tool/use-tool-run"
import {
  HeatmapMap,
  isGoogleMapsConfigured,
} from "@/components/tool/HeatmapMap"
import {
  estimateGrid,
  HEATMAP_PRESETS,
  rankColor,
} from "@/lib/gbp-heatmap"
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
  /** Set by the route when the grid is too big to scan synchronously. */
  requires_job?: boolean
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

type JobProgress = { stage?: string; detail?: string; percent?: number | null }

export default function GbpHeatmapPage() {
  const tool = findToolByPathname("/local/gbp-heatmap")!
  const [business, setBusiness] = useState("")
  const [keyword, setKeyword] = useState("")
  const [market, setMarket] = useState<DfsLabsLocation | null>(null)
  const [presetKey, setPresetKey] = useState<string>(HEATMAP_PRESETS[0].key)
  const [selected, setSelected] = useState<SelectedKey>("target")

  // Flow state. `data` is the full scan result (synchronous or job-completed)
  // that ResultsView renders. The other slots cover the in-between states.
  const [data, setData] = useState<Data | null>(null)
  const [candidates, setCandidates] = useState<Candidate[] | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [meta, setMeta] = useState<ToolRunMeta | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [jobId, setJobId] = useState<string | null>(null)
  const [jobProgress, setJobProgress] = useState<JobProgress | null>(null)

  const preset = useMemo(
    () => HEATMAP_PRESETS.find((p) => p.key === presetKey) ?? HEATMAP_PRESETS[0],
    [presetKey],
  )
  const est = useMemo(
    () => estimateGrid(preset.rows, preset.cols, preset.spacingKm),
    [preset],
  )
  const busy = loading || jobId != null

  // Resume a previously-started scan when landing on ?job=<id> (e.g. from the
  // header Jobs tray or the per-kind card's View link). Read from the URL
  // directly to avoid a Suspense boundary around useSearchParams.
  useEffect(() => {
    if (typeof window === "undefined") return
    const j = new URLSearchParams(window.location.search).get("job")
    // One-time sync of the URL's ?job= into state on mount; an effect is the
    // right tool here (avoids a hydration mismatch from reading window during
    // render). The polling effect below takes over once jobId is set.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (j) setJobId(j)
  }, [])

  // Poll the background job until it reaches a terminal state, then fold its
  // result into `data` so ResultsView renders identically to a sync scan.
  useEffect(() => {
    if (!jobId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const poll = async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" })
        if (res.ok) {
          const body = (await res.json()) as {
            job: {
              status: string
              result:
                | (Data & { costUsd?: number; durationSeconds?: number })
                | null
              error: string | null
              progress: JobProgress | null
            }
          }
          if (cancelled) return
          setJobProgress(body.job.progress ?? null)
          if (body.job.status === "completed") {
            const result = body.job.result ?? null
            setData(result)
            if (result) {
              setMeta({
                endpoints: result.endpoints_called ?? [],
                costUsd: result.costUsd,
                durationMs:
                  typeof result.durationSeconds === "number"
                    ? result.durationSeconds * 1000
                    : 0,
              })
            }
            setJobId(null)
            return
          }
          if (body.job.status === "failed") {
            setError(body.job.error ?? "Background scan failed.")
            setJobId(null)
            return
          }
          if (body.job.status === "cancelled") {
            setError("Scan cancelled.")
            setJobId(null)
            return
          }
        }
      } catch {
        /* transient — retry on the next tick */
      }
      if (!cancelled) timer = setTimeout(poll, 3000)
    }
    void poll()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [jobId])

  async function startJob(target: Target) {
    const res = await fetch("/api/jobs/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "gbp_heatmap",
        title: `${keyword.trim()} — ${target.title}`,
        input: {
          keyword: keyword.trim(),
          language_code: "en",
          grid_rows: preset.rows,
          grid_cols: preset.cols,
          spacing_km: preset.spacingKm,
          target,
        },
      }),
    })
    const body = (await res.json()) as { jobId?: string; error?: string }
    if (!res.ok || !body.jobId) {
      throw new Error(body.error ?? "Could not start background scan.")
    }
    // Drop the resolution-only meta (one cheap GBP call); the real scan
    // cost/duration get filled in from the job result on completion.
    setMeta(null)
    setJobProgress({ stage: "Queued" })
    setJobId(body.jobId)
  }

  async function submit(override?: SubmitOverride) {
    if (!business.trim()) return setError("Enter a business name.")
    if (!keyword.trim()) return setError("Enter a keyword.")
    if (!override && !market) return setError("Pick a market (city/state).")
    setError(null)
    setSelected("target")
    setData(null)
    setCandidates(null)
    setNotFound(false)
    setJobId(null)
    setJobProgress(null)
    setLoading(true)
    try {
      const res = await fetch("/api/tools/local/gbp-heatmap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          business: business.trim(),
          keyword: keyword.trim(),
          location_code: market?.location_code,
          location_name: market ? undefined : "United States",
          grid_rows: preset.rows,
          grid_cols: preset.cols,
          spacing_km: preset.spacingKm,
          ...override,
        }),
      })
      const payload = (await res.json()) as {
        data?: Data
        meta?: ToolRunMeta
        error?: string
      }
      if (!res.ok) throw new Error(payload.error ?? `HTTP ${res.status}`)
      const d = payload.data
      setMeta(payload.meta ?? null)
      if (!d) throw new Error("Empty response.")
      if (d.status === "not_found") {
        setNotFound(true)
      } else if (d.status === "ambiguous") {
        setCandidates(d.candidates ?? [])
      } else if (d.requires_job) {
        if (!d.target) throw new Error("Resolution returned no business to scan.")
        await startJob(d.target)
      } else {
        setData(d)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed")
    } finally {
      setLoading(false)
    }
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
      save={{
        kind: "gbp_heatmap",
        enabled: data != null,
        getDefaultTitle: () => `${keyword || "Keyword"} — GBP heatmap`,
        getData: () => ({
          keyword,
          capturedAt: new Date().toISOString(),
          ...data,
        }),
      }}
      form={
        <form onSubmit={onSubmit} className="space-y-4 print:hidden">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_1fr_260px]">
            <div className="space-y-1.5">
              <Label htmlFor="business">Business name</Label>
              <Input
                id="business"
                value={business}
                onChange={(e) => setBusiness(e.target.value)}
                placeholder="Shade Number Seven"
                disabled={busy}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="keyword">Keyword</Label>
              <Input
                id="keyword"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="window blinds"
                disabled={busy}
              />
            </div>
            <MarketPicker value={market} onChange={setMarket} label="City" />
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-[260px_1fr_auto] md:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="preset">Coverage</Label>
              <Select
                value={presetKey}
                onValueChange={setPresetKey}
                disabled={busy}
              >
                <SelectTrigger id="preset">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HEATMAP_PRESETS.map((p) => (
                    <SelectItem key={p.key} value={p.key}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className="font-mono text-[11px] leading-relaxed text-ink-3 md:pb-2">
              {est.points} vantage points · ~{est.edgeRadiusMiles.toFixed(0)} mi
              radius (~{est.widthMiles.toFixed(0)}×{est.heightMiles.toFixed(0)} mi)
              · est. ${est.estCostUsd.toFixed(2)}
              {est.background ? (
                <>
                  {" · "}
                  <span className="font-semibold text-amber-700">
                    runs in background
                  </span>
                </>
              ) : null}
              <br />
              <span className="text-ink-3/80">{preset.blurb}</span>
            </p>
            <Button type="submit" disabled={busy}>
              {busy ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              {est.background ? "Run Background Scan" : "Run Heatmap Scan"}
            </Button>
          </div>
        </form>
      }
      results={
        <>
          <JobsForKindCard
            kind="gbp_heatmap"
            title="Recent heatmap scans"
          />
          {error ? (
            <ToolError message={error} />
          ) : data && data.status === "ok" && !data.requires_job ? (
            <ResultsView
              data={data}
              selected={selected}
              onSelect={setSelected}
              onExport={exportPdf}
              keyword={keyword}
            />
          ) : notFound ? (
            <NotFoundPanel business={business} />
          ) : candidates ? (
            <Disambiguation
              candidates={candidates}
              onPick={selectCandidate}
              disabled={busy}
            />
          ) : busy ? (
            <ScanProgress background={jobId != null} progress={jobProgress} />
          ) : null}
        </>
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

function ScanProgress({
  background = false,
  progress = null,
}: {
  background?: boolean
  progress?: { stage?: string; detail?: string; percent?: number | null } | null
}) {
  const stage = progress?.stage
  const detail = progress?.detail
  return (
    <div className="rounded-xl border border-dashed border-line bg-card/40 px-6 py-10 text-center">
      <Loader2 className="mx-auto h-6 w-6 animate-spin text-ink-3" />
      <p className="mt-3 font-sans text-[13px] font-semibold text-foreground">
        {stage
          ? `${stage}${detail ? ` — ${detail}` : ""}`
          : "Scanning Google Maps from each grid vantage point…"}
      </p>
      <p className="mt-1 font-serif text-[12px] text-ink-3">
        {background
          ? "Large grids run as a background job — you can leave this page and we'll email you when it finishes. Progress also shows in the Jobs tray."
          : "~10-30 seconds. Resolving business, then running the grid SERP calls in parallel."}
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
          one will trigger the grid scan against that location.
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
