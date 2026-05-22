"use client"

import { useMemo, useState, type FormEvent } from "react"
import {
  BookOpen,
  HelpCircle,
  ImageIcon,
  Link as LinkIcon,
  Loader2,
  MapPin,
  MessageCircleQuestion,
  Plus,
  Quote,
  Search,
  ShoppingCart,
  Target,
  TrendingUp,
  Video,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { MarketPicker } from "@/components/tool/MarketPicker"
import { ToolShell } from "@/components/tool/ToolShell"
import { ToolError, useToolRun } from "@/components/tool/use-tool-run"
import { findToolByPathname } from "@/lib/tool-config"
import type { DfsLabsLocation } from "@/lib/types"
import { cn } from "@/lib/utils"

type MarketKey = "national" | `city:${number}`

type ScopeMarket = {
  key: MarketKey
  label: string
  location_code: number
  location_name: string
  is_national: boolean
}

type Kpis = {
  volume: number | null
  cpc: number | null
  ad_density: number | null
  keyword_difficulty: number | null
  intent: string | null
}

type TrendPoint = { date: string; volume: number | null }

type CityVolume = {
  key: MarketKey
  label: string
  volume: number | null
}

type SerpRow = {
  position: number
  domain: string
  url: string
  title: string | null
  rank: number | null
  is_user_domain: boolean
}

type RelatedRow = { keyword: string; volume: number | null }

type Data = {
  keyword: string
  user_domain: string | null
  markets: ScopeMarket[]
  kpis: Record<MarketKey, Kpis>
  trend: TrendPoint[]
  city_volumes: CityVolume[]
  serp: SerpRow[]
  serp_features: string[]
  paa: string[]
  related: RelatedRow[]
  phrase_match: RelatedRow[]
}

const FEATURE_META: Record<
  string,
  { label: string; Icon: typeof MapPin }
> = {
  local_pack: { label: "Local pack", Icon: MapPin },
  map: { label: "Map pack", Icon: MapPin },
  images: { label: "Image pack", Icon: ImageIcon },
  image_pack: { label: "Image pack", Icon: ImageIcon },
  people_also_ask: { label: "People also ask", Icon: MessageCircleQuestion },
  related_questions: { label: "Related questions", Icon: MessageCircleQuestion },
  faq: { label: "FAQ", Icon: HelpCircle },
  faq_box: { label: "FAQ", Icon: HelpCircle },
  shopping: { label: "Shopping ads", Icon: ShoppingCart },
  carousel: { label: "Carousel", Icon: BookOpen },
  knowledge_graph: { label: "Knowledge graph", Icon: BookOpen },
  featured_snippet: { label: "Featured snippet", Icon: Quote },
  video: { label: "Video", Icon: Video },
  videos: { label: "Video", Icon: Video },
  sitelinks: { label: "Sitelinks", Icon: LinkIcon },
  top_stories: { label: "Top stories", Icon: BookOpen },
}

function difficultyTone(kd: number | null): {
  color: string
  band: string
} {
  if (kd == null) return { color: "text-ink-2", band: "—" }
  if (kd < 30) return { color: "text-success-dark", band: "Easy" }
  if (kd < 50) return { color: "text-warning-dark", band: "Possible" }
  if (kd < 70) return { color: "text-warning-dark", band: "Difficult" }
  return { color: "text-destructive", band: "Hard" }
}

function adDensityBand(d: number | null): string {
  if (d == null) return "—"
  if (d < 0.33) return "Low"
  if (d < 0.66) return "Medium"
  return "High"
}

function formatMonthLabel(yyyymm: string): string {
  const [y, m] = yyyymm.split("-").map(Number)
  if (!y || !m) return yyyymm
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", {
    month: "short",
    timeZone: "UTC",
  })
}

function formatVolume(v: number | null): string {
  if (v == null) return "—"
  return v.toLocaleString()
}

function VolumeTrendChart({ points }: { points: TrendPoint[] }) {
  const width = 560
  const height = 180
  const padLeft = 36
  const padRight = 12
  const padTop = 14
  const padBottom = 22
  const hasData = points.some((p) => typeof p.volume === "number")
  if (!hasData) {
    return (
      <div className="flex h-[180px] items-center justify-center font-serif text-[13px] text-ink-3">
        No historical volume data available.
      </div>
    )
  }
  const values = points.map((p) => p.volume ?? 0)
  const max = Math.max(...values)
  const min = Math.min(...values.filter((v) => v > 0))
  const yMax = max === 0 ? 1 : max * 1.1
  const yMin = Math.max(0, min * 0.8)
  const range = yMax - yMin || 1
  const plotW = width - padLeft - padRight
  const plotH = height - padTop - padBottom
  const x = (i: number) =>
    padLeft + (points.length <= 1 ? plotW / 2 : (i * plotW) / (points.length - 1))
  const y = (v: number) => padTop + plotH - ((v - yMin) / range) * plotH

  const linePath = points
    .map((p, i) => {
      const v = p.volume ?? 0
      return `${i === 0 ? "M" : "L"}${x(i).toFixed(2)},${y(v).toFixed(2)}`
    })
    .join(" ")
  const fillPath =
    `M${x(0).toFixed(2)},${y(points[0]?.volume ?? 0).toFixed(2)} ` +
    points
      .slice(1)
      .map((p, i) => `L${x(i + 1).toFixed(2)},${y(p.volume ?? 0).toFixed(2)}`)
      .join(" ") +
    ` L${x(points.length - 1).toFixed(2)},${(padTop + plotH).toFixed(2)} L${x(0).toFixed(2)},${(padTop + plotH).toFixed(2)} Z`

  const yTicks = 4
  const tickValues = Array.from({ length: yTicks + 1 }, (_, i) => {
    return yMin + (range * i) / yTicks
  })

  const monthAriaLabel = points
    .map((p) => `${formatMonthLabel(p.date)} ${formatVolume(p.volume)}`)
    .join(", ")

  return (
    <div className="w-full">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-[180px] w-full"
        role="img"
        aria-label={`12-month search volume trend: ${monthAriaLabel}`}
      >
        {tickValues.map((tv, i) => (
          <g key={i}>
            <line
              x1={padLeft}
              x2={width - padRight}
              y1={y(tv)}
              y2={y(tv)}
              stroke="var(--line)"
              strokeDasharray={i === 0 ? undefined : "2 3"}
              strokeWidth={0.5}
            />
            <text
              x={padLeft - 6}
              y={y(tv) + 3}
              fontSize="10"
              textAnchor="end"
              fill="var(--ink-3)"
              fontFamily="var(--font-mono, monospace)"
            >
              {tv >= 1000
                ? `${(Math.round(tv / 100) / 10).toFixed(1)}K`
                : Math.round(tv).toString()}
            </text>
          </g>
        ))}
        <path d={fillPath} fill="rgba(23,65,86,0.08)" />
        <path
          d={linePath}
          fill="none"
          stroke="var(--color-info)"
          strokeWidth={1.8}
        />
        {points.map((p, i) => {
          if (p.volume == null) return null
          return (
            <circle
              key={p.date}
              cx={x(i)}
              cy={y(p.volume)}
              r={2.5}
              fill="var(--color-info)"
            />
          )
        })}
        {points.map((p, i) => (
          <text
            key={`x-${p.date}`}
            x={x(i)}
            y={height - 6}
            fontSize="10"
            textAnchor="middle"
            fill="var(--ink-3)"
            fontFamily="var(--font-mono, monospace)"
          >
            {formatMonthLabel(p.date)}
          </text>
        ))}
      </svg>
    </div>
  )
}

function CityVolumeBars({ rows }: { rows: CityVolume[] }) {
  if (rows.length === 0) {
    return (
      <p className="font-serif text-[13px] text-ink-3">
        Add a city scope above to see per-city volume.
      </p>
    )
  }
  const max = Math.max(
    1,
    ...rows.map((r) => (typeof r.volume === "number" ? r.volume : 0)),
  )
  return (
    <div className="flex flex-col gap-2.5">
      {rows.map((r) => {
        const v = r.volume ?? 0
        const pct = (v / max) * 100
        return (
          <div key={r.key}>
            <div className="mb-1 flex items-center justify-between text-[12px]">
              <span className="text-ink-2">{r.label}</span>
              <span className="font-medium tabular-nums">
                {formatVolume(r.volume)}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded bg-secondary">
              <div
                className="h-full rounded bg-info"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function ScopeChip({
  market,
  active,
  onClick,
}: {
  market: ScopeMarket
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`location_code ${market.location_code} (${market.location_name})`}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-transparent px-2.5 py-1 text-[12px] transition-colors",
        active
          ? "bg-info text-white"
          : "bg-secondary text-foreground hover:bg-accent",
      )}
    >
      {market.label}
    </button>
  )
}

function FeaturePill({ slug }: { slug: string }) {
  const meta = FEATURE_META[slug]
  if (!meta) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md bg-secondary px-2.5 py-1 font-sans text-[12px] text-ink-2">
        {slug
          .split("_")
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(" ")}
      </span>
    )
  }
  const Icon = meta.Icon
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-secondary px-2.5 py-1 font-sans text-[12px] text-ink-2">
      <Icon className="h-3.5 w-3.5" />
      {meta.label}
    </span>
  )
}

function KpiCard({
  label,
  value,
  hint,
  valueClass,
}: {
  label: string
  value: React.ReactNode
  hint?: React.ReactNode
  valueClass?: string
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg bg-secondary/70 px-3.5 py-3">
      <span className="font-sans text-[11px] uppercase tracking-wide text-ink-3">
        {label}
      </span>
      <span
        className={cn(
          "font-sans text-[22px] font-medium leading-tight",
          valueClass,
        )}
      >
        {value}
      </span>
      {hint ? (
        <span className="font-sans text-[11px] text-ink-3">{hint}</span>
      ) : null}
    </div>
  )
}

export default function KeywordOverviewPage() {
  const tool = findToolByPathname("/keywords/overview")!
  const [keyword, setKeyword] = useState("")
  const [baseMarket, setBaseMarket] = useState<DfsLabsLocation | null>(null)
  const [cityMarkets, setCityMarkets] = useState<DfsLabsLocation[]>([])
  const [cityPicker, setCityPicker] = useState<DfsLabsLocation | null>(null)
  const [userDomain, setUserDomain] = useState("")
  const { data, meta, loading, error, run, setError } = useToolRun<Data>(
    "/api/tools/keywords/overview",
  )
  const [activeScope, setActiveScope] = useState<MarketKey>("national")

  function addCityMarket() {
    if (!cityPicker) return
    if (
      cityMarkets.some((m) => m.location_code === cityPicker.location_code)
    ) {
      setCityPicker(null)
      return
    }
    setCityMarkets((prev) => [...prev, cityPicker])
    setCityPicker(null)
  }

  function removeCityMarket(code: number) {
    setCityMarkets((prev) => prev.filter((m) => m.location_code !== code))
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!keyword.trim()) {
      setError("Enter a keyword.")
      return
    }
    setActiveScope("national")
    await run({
      keyword: keyword.trim(),
      location_code: baseMarket?.location_code,
      location_name: baseMarket ? undefined : "United States",
      city_markets: cityMarkets.map((m) => ({
        location_code: m.location_code,
        location_name: m.location_name,
      })),
      user_domain: userDomain.trim() || undefined,
    })
  }

  const activeKpis = useMemo<Kpis | null>(() => {
    if (!data) return null
    return data.kpis[activeScope] ?? data.kpis.national ?? null
  }, [data, activeScope])

  const trendYoY = useMemo<number | null>(() => {
    if (!data || data.trend.length < 12) return null
    const last = data.trend[data.trend.length - 1]?.volume
    const yearAgo = data.trend[0]?.volume
    if (!last || !yearAgo) return null
    return ((last - yearAgo) / yearAgo) * 100
  }, [data])

  return (
    <ToolShell
      category="Keywords"
      title={tool.label}
      description={tool.description}
      endpoints={tool.endpoints}
      save={{
        kind: "keyword_overview",
        enabled: data != null,
        getDefaultTitle: () => `${keyword || "Keyword"} — Overview`,
        getData: () => ({
          keyword,
          capturedAt: new Date().toISOString(),
          ...data,
        }),
      }}
      meta={meta}
      form={
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_280px]">
            <div className="space-y-1.5">
              <Label htmlFor="keyword">Keyword</Label>
              <Input
                id="keyword"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="silhouette shades"
                disabled={loading}
              />
            </div>
            <div className="flex flex-col gap-3">
              <MarketPicker
                value={baseMarket}
                onChange={setBaseMarket}
                label="Base market (national)"
                inputId="base-market"
              />
              <Button type="submit" disabled={loading} className="mt-auto">
                {loading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                Run Keyword Overview
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 border-t border-dashed border-line pt-3 md:grid-cols-[1fr_280px]">
            <div className="space-y-1.5">
              <Label htmlFor="user-domain">Your domain (optional)</Label>
              <Input
                id="user-domain"
                value={userDomain}
                onChange={(e) => setUserDomain(e.target.value)}
                placeholder="example.com"
                disabled={loading}
              />
              <p className="text-xs text-ink-3">
                Highlighted in SERP composition when present in the top 10.
              </p>
            </div>
            <div className="space-y-2">
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <MarketPicker
                    value={cityPicker}
                    onChange={setCityPicker}
                    label="Add city scope"
                    inputId="city-picker"
                    helpText="Each city adds one google_ads/search_volume call."
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!cityPicker || loading}
                  onClick={addCityMarket}
                >
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  Add
                </Button>
              </div>
              {cityMarkets.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {cityMarkets.map((m) => (
                    <span
                      key={m.location_code}
                      className="inline-flex items-center gap-1 rounded-md bg-info-light px-2 py-1 font-mono text-[11px] text-info-dark"
                    >
                      {m.location_name}
                      <button
                        type="button"
                        onClick={() => removeCityMarket(m.location_code)}
                        className="text-info-dark/70 hover:text-info-dark"
                        aria-label={`Remove ${m.location_name}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </form>
      }
      results={
        error ? (
          <ToolError message={error} />
        ) : !data ? (
          <div className="rounded-lg border border-dashed border-line bg-muted/30 px-6 py-10 text-center">
            <p className="font-serif text-[13.5px] text-ink-3">
              Enter a keyword above to see volume, difficulty, intent, trend,
              SERP composition, and related keywords.
            </p>
          </div>
        ) : (
          <KeywordOverviewResults
            data={data}
            activeScope={activeScope}
            setActiveScope={setActiveScope}
            activeKpis={activeKpis}
            trendYoY={trendYoY}
          />
        )
      }
    />
  )
}

function KeywordOverviewResults({
  data,
  activeScope,
  setActiveScope,
  activeKpis,
  trendYoY,
}: {
  data: Data
  activeScope: MarketKey
  setActiveScope: (k: MarketKey) => void
  activeKpis: Kpis | null
  trendYoY: number | null
}) {
  const kdTone = difficultyTone(activeKpis?.keyword_difficulty ?? null)
  const adDensityLabel = adDensityBand(activeKpis?.ad_density ?? null)

  return (
    <div className="space-y-4">
      {/* Hero card: keyword + scope chips + KPIs */}
      <div className="rounded-lg border border-line bg-card px-5 py-4">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="font-sans text-[11px] uppercase tracking-[0.18em] text-ink-3">
              Keyword
            </p>
            <p className="mt-1 font-sans text-[26px] font-medium leading-tight">
              {data.keyword}
            </p>
          </div>
          <div className="text-right">
            <p className="font-sans text-[11px] uppercase tracking-[0.18em] text-ink-3">
              Scope
            </p>
            <div className="mt-1 flex flex-wrap justify-end gap-1">
              {data.markets.map((m) => (
                <ScopeChip
                  key={m.key}
                  market={m}
                  active={m.key === activeScope}
                  onClick={() => setActiveScope(m.key)}
                />
              ))}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2.5 md:grid-cols-5">
          <KpiCard
            label="Volume"
            value={formatVolume(activeKpis?.volume ?? null)}
            hint={
              trendYoY != null && activeScope === "national" ? (
                <span
                  className={cn(
                    trendYoY >= 0 ? "text-success-dark" : "text-destructive",
                  )}
                >
                  {trendYoY >= 0 ? "+" : ""}
                  {trendYoY.toFixed(0)}% YoY
                </span>
              ) : null
            }
          />
          <KpiCard
            label="Difficulty"
            value={activeKpis?.keyword_difficulty ?? "—"}
            valueClass={kdTone.color}
            hint={kdTone.band}
          />
          <KpiCard
            label="CPC"
            value={
              activeKpis?.cpc == null
                ? "—"
                : `$${activeKpis.cpc.toFixed(2)}`
            }
          />
          <KpiCard
            label="Ad density"
            value={
              activeKpis?.ad_density == null
                ? "—"
                : activeKpis.ad_density.toFixed(2)
            }
            hint={adDensityLabel}
          />
          <KpiCard
            label="Intent"
            value={
              <span className="text-[18px]">
                {activeKpis?.intent ?? "—"}
              </span>
            }
          />
        </div>
        <p className="mt-3 font-mono text-[10.5px] text-ink-3">
          keyword_overview · search_intent · keywords_data/google_ads/search_volume
          (city scope)
        </p>
      </div>

      {/* Volume trend + city volume */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[1.4fr_1fr]">
        <div className="rounded-lg border border-line bg-card px-5 py-4">
          <p className="mb-3 inline-flex items-center gap-1.5 font-sans text-[13px] font-medium">
            <TrendingUp className="h-4 w-4" />
            Volume trend · 12 months
          </p>
          <VolumeTrendChart points={data.trend} />
          <p className="mt-3 font-mono text-[10.5px] text-ink-3">
            historical_keyword_data · monthly buckets
          </p>
        </div>
        <div className="rounded-lg border border-line bg-card px-5 py-4">
          <p className="mb-3 inline-flex items-center gap-1.5 font-sans text-[13px] font-medium">
            <MapPin className="h-4 w-4" />
            City volume
          </p>
          <CityVolumeBars rows={data.city_volumes} />
          <p className="mt-3 font-mono text-[10.5px] text-ink-3">
            google_ads/search_volume · per city_code
          </p>
        </div>
      </div>

      {/* SERP composition */}
      <div className="rounded-lg border border-line bg-card px-5 py-4">
        <p className="mb-3 inline-flex items-center gap-1.5 font-sans text-[13px] font-medium">
          <Search className="h-4 w-4" />
          SERP composition
          {data.user_domain ? (
            <span className="ml-1.5 font-sans text-[12px] font-normal text-ink-3">
              · {data.user_domain} highlighted
            </span>
          ) : null}
        </p>
        {data.serp.length === 0 ? (
          <p className="font-serif text-[13px] text-ink-3">
            No SERP results returned.
          </p>
        ) : (
          <div className="divide-y divide-line">
            {data.serp.map((row) => (
              <div
                key={`${row.position}-${row.url}`}
                className={cn(
                  "grid grid-cols-[28px_minmax(0,1fr)_84px] items-center gap-2 px-1 py-2",
                  row.is_user_domain
                    ? "-mx-2 rounded-md bg-success-light/60 px-3"
                    : "",
                )}
              >
                <span
                  className={cn(
                    "text-center font-sans text-[13px] font-medium",
                    row.is_user_domain ? "text-success-dark" : "text-ink-2",
                  )}
                >
                  {row.position}
                </span>
                <div className="min-w-0">
                  <p className="truncate font-sans text-[13px] font-medium">
                    {row.title ?? row.url}
                  </p>
                  <p
                    className={cn(
                      "truncate font-sans text-[11px]",
                      row.is_user_domain
                        ? "text-success-dark"
                        : "text-ink-2",
                    )}
                  >
                    {row.domain}
                    {row.is_user_domain ? " · your domain" : ""}
                  </p>
                </div>
                <span className="text-right font-mono text-[11px] tabular-nums text-ink-3">
                  {row.rank == null ? "—" : `Rank ${row.rank.toLocaleString()}`}
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="mt-3 font-mono text-[10.5px] text-ink-3">
          serp/google/organic/live/advanced · domain rank joined from
          backlinks/bulk_ranks per ranking domain
        </p>
      </div>

      {/* SERP features present */}
      <div className="rounded-lg border border-line bg-card px-5 py-4">
        <p className="mb-3 inline-flex items-center gap-1.5 font-sans text-[13px] font-medium">
          <Target className="h-4 w-4" />
          SERP features present
        </p>
        {data.serp_features.length === 0 ? (
          <p className="font-serif text-[13px] text-ink-3">
            No SERP features detected.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {data.serp_features.map((f) => (
              <FeaturePill key={f} slug={f} />
            ))}
          </div>
        )}
        <p className="mt-3 font-mono text-[10.5px] text-ink-3">
          serp/google/organic/live/advanced · item_types and SERP feature flags
        </p>
      </div>

      {/* People also ask */}
      {data.paa.length > 0 ? (
        <div className="rounded-lg border border-line bg-card px-5 py-4">
          <p className="mb-3 inline-flex items-center gap-1.5 font-sans text-[13px] font-medium">
            <MessageCircleQuestion className="h-4 w-4" />
            People also ask
          </p>
          <ul className="space-y-1.5 pl-5 font-serif text-[13px] leading-relaxed list-disc">
            {data.paa.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
          <p className="mt-3 font-mono text-[10.5px] text-ink-3">
            serp/google/organic/live/advanced · people_also_ask · click depth 2
          </p>
        </div>
      ) : null}

      {/* Related + phrase match */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <KeywordListCard
          icon={<LinkIcon className="h-4 w-4" />}
          title="Related keywords"
          rows={data.related}
          source="related_keywords"
        />
        <KeywordListCard
          icon={<BookOpen className="h-4 w-4" />}
          title="Phrase match"
          rows={data.phrase_match}
          source="keyword_suggestions · contains seed"
        />
      </div>
    </div>
  )
}

function KeywordListCard({
  icon,
  title,
  rows,
  source,
}: {
  icon: React.ReactNode
  title: string
  rows: RelatedRow[]
  source: string
}) {
  return (
    <div className="rounded-lg border border-line bg-card px-5 py-4">
      <p className="mb-3 inline-flex items-center gap-1.5 font-sans text-[13px] font-medium">
        {icon}
        {title}
      </p>
      {rows.length === 0 ? (
        <p className="font-serif text-[13px] text-ink-3">No results.</p>
      ) : (
        <table className="w-full border-collapse text-[12.5px]">
          <tbody>
            {rows.map((r) => (
              <tr key={r.keyword} className="border-b border-line/60">
                <td className="py-1.5">{r.keyword}</td>
                <td className="py-1.5 text-right font-medium tabular-nums">
                  {formatVolume(r.volume)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-3 font-mono text-[10.5px] text-ink-3">{source}</p>
    </div>
  )
}
