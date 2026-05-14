"use client"

import { useMemo, useState, type FormEvent } from "react"
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Download,
  FilePlus,
  HelpCircle,
  ImageIcon,
  Link as LinkIcon,
  Loader2,
  MapPin,
  MessageCircleQuestion,
  Plus,
  Quote,
  Search,
  Video,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { MarketPicker } from "@/components/tool/MarketPicker"
import { ToolShell } from "@/components/tool/ToolShell"
import { ToolError, useToolRun } from "@/components/tool/use-tool-run"
import { buildRowsWorkbook, downloadWorkbook } from "@/lib/tool-xlsx"
import { findToolByPathname } from "@/lib/tool-config"
import type { DfsLabsLocation } from "@/lib/types"
import { cn } from "@/lib/utils"

type MarketKey = "national" | `city:${number}`

type SourceTag = "suggestion" | "idea" | "related"

type MagicMarket = {
  key: MarketKey
  label: string
  location_code: number
  location_name: string
  is_national: boolean
  coverage: number
  queried: number
}

type MagicRow = {
  keyword: string
  source: SourceTag
  intent: "I" | "N" | "C" | "T" | null
  volumes: Record<MarketKey, number | null>
  kd: number | null
  cpc: number | null
  competition_level: string | null
  serp_features: string[]
  is_question: boolean
}

type Data = {
  seed: string
  markets: MagicMarket[]
  counts: {
    all: number
    phrase: number
    related: number
    pasf: number
    questions: number
  }
  stats: {
    total: number
    avg_volume: number | null
    avg_kd: number | null
  }
  rows: MagicRow[]
}

type MatchMode = "all" | "phrase" | "related" | "pasf" | "questions"

const PAGE_SIZE = 25

const INTENT_LABELS: Record<"I" | "N" | "C" | "T", string> = {
  I: "Informational",
  N: "Navigational",
  C: "Commercial",
  T: "Transactional",
}

const SOURCE_BADGE: Record<SourceTag, string> = {
  suggestion: "Sug",
  idea: "Idea",
  related: "Rel",
}

const SERP_FEATURE_ICON: Record<
  string,
  { icon: typeof MapPin; title: string }
> = {
  local_pack: { icon: MapPin, title: "Local pack" },
  map: { icon: MapPin, title: "Map pack" },
  people_also_ask: { icon: MessageCircleQuestion, title: "People also ask" },
  related_questions: {
    icon: MessageCircleQuestion,
    title: "Related questions",
  },
  images: { icon: ImageIcon, title: "Image pack" },
  image_pack: { icon: ImageIcon, title: "Image pack" },
  featured_snippet: { icon: Quote, title: "Featured snippet" },
  faq: { icon: HelpCircle, title: "FAQ" },
  sitelinks: { icon: LinkIcon, title: "Sitelinks" },
  video: { icon: Video, title: "Video carousel" },
  knowledge_graph: { icon: BookOpen, title: "Knowledge graph" },
}

function SerpFeatureIcons({ features }: { features: string[] }) {
  // Collapse synonyms (local_pack + map; images + image_pack; people_also_ask
  // + related_questions) so we don't double-render the same icon.
  const seen = new Set<string>()
  const items: { Icon: typeof MapPin; title: string }[] = []
  for (const slug of features) {
    const spec = SERP_FEATURE_ICON[slug]
    if (!spec) continue
    if (seen.has(spec.title)) continue
    seen.add(spec.title)
    items.push({ Icon: spec.icon, title: spec.title })
  }
  if (items.length === 0) return <span className="text-ink-3">—</span>
  return (
    <span className="inline-flex items-center gap-1">
      {items.map(({ Icon, title }, i) => (
        <Icon
          key={i}
          aria-label={title}
          className="h-3.5 w-3.5 text-ink-3"
        />
      ))}
    </span>
  )
}

function Chip({
  children,
  active,
  onClick,
  count,
  className,
  title,
}: {
  children: React.ReactNode
  active?: boolean
  onClick?: () => void
  count?: number
  className?: string
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border border-transparent px-2.5 py-1 text-[12px] transition-colors",
        active
          ? "bg-[#0F6E56] text-white"
          : "bg-secondary text-foreground hover:bg-accent",
        className,
      )}
    >
      <span>{children}</span>
      {count != null ? (
        <span
          className={cn(
            "tabular-nums text-[11px]",
            active ? "text-[#9FE1CB]" : "text-ink-3",
          )}
        >
          {count.toLocaleString()}
        </span>
      ) : null}
    </button>
  )
}

function MiniBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block rounded-sm bg-secondary px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-ink-2">
      {children}
    </span>
  )
}

export default function KeywordMagicPage() {
  const tool = findToolByPathname("/keywords/magic")!
  const [seed, setSeed] = useState("")
  const [baseMarket, setBaseMarket] = useState<DfsLabsLocation | null>(null)
  const [cityMarkets, setCityMarkets] = useState<DfsLabsLocation[]>([])
  const [cityPicker, setCityPicker] = useState<DfsLabsLocation | null>(null)
  const { data, meta, loading, error, run, setError } = useToolRun<Data>(
    "/api/tools/keywords/magic",
  )

  // ── UI state for the results pane ─────────────────────────────────────
  const [activeMarketKey, setActiveMarketKey] = useState<MarketKey>("national")
  const [matchMode, setMatchMode] = useState<MatchMode>("all")
  const [volumeMin, setVolumeMin] = useState<string>("")
  const [kdMax, setKdMax] = useState<string>("")
  const [intentFilters, setIntentFilters] = useState<
    Set<"I" | "N" | "C" | "T">
  >(new Set())
  const [textFilter, setTextFilter] = useState("")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [page, setPage] = useState(0)

  function addCityMarket() {
    if (!cityPicker) return
    if (cityMarkets.some((m) => m.location_code === cityPicker.location_code)) {
      setCityPicker(null)
      return
    }
    setCityMarkets((prev) => [...prev, cityPicker])
    setCityPicker(null)
  }

  function removeCityMarket(code: number) {
    setCityMarkets((prev) => prev.filter((m) => m.location_code !== code))
  }

  function toggleIntent(letter: "I" | "N" | "C" | "T") {
    setIntentFilters((prev) => {
      const next = new Set(prev)
      if (next.has(letter)) next.delete(letter)
      else next.add(letter)
      return next
    })
    setPage(0)
  }

  function clearFilters() {
    setVolumeMin("")
    setKdMax("")
    setIntentFilters(new Set())
    setMatchMode("all")
    setTextFilter("")
    setPage(0)
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!seed.trim()) {
      setError("Enter a seed keyword.")
      return
    }
    setSelected(new Set())
    setMatchMode("all")
    setActiveMarketKey("national")
    setPage(0)
    await run({
      seed: seed.trim(),
      location_code: baseMarket?.location_code,
      location_name: baseMarket ? undefined : "United States",
      city_markets: cityMarkets.map((m) => ({
        location_code: m.location_code,
        location_name: m.location_name,
      })),
    })
  }

  // ── Derived filtered rows ─────────────────────────────────────────────
  const filteredRows = useMemo(() => {
    if (!data) return [] as MagicRow[]
    const min = volumeMin.trim() ? Number(volumeMin) : null
    const max = kdMax.trim() ? Number(kdMax) : null
    const needle = textFilter.trim().toLowerCase()
    return data.rows.filter((r) => {
      if (matchMode === "phrase" && r.source !== "suggestion") return false
      if (matchMode === "related" && r.source !== "idea") return false
      if (matchMode === "pasf" && r.source !== "related") return false
      if (matchMode === "questions" && !r.is_question) return false
      if (intentFilters.size > 0 && (!r.intent || !intentFilters.has(r.intent)))
        return false
      const v = r.volumes[activeMarketKey] ?? null
      // When a city scope is active, drop rows that have no Ads volume
      // for that city (national kept as-is so the default view stays full).
      if (activeMarketKey !== "national" && (v == null || v === 0)) return false
      if (min != null && (v == null || v < min)) return false
      if (max != null && (r.kd == null || r.kd > max)) return false
      if (needle && !r.keyword.toLowerCase().includes(needle)) return false
      return true
    })
  }, [data, matchMode, intentFilters, volumeMin, kdMax, activeMarketKey, textFilter])

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages - 1)
  const pagedRows = filteredRows.slice(
    safePage * PAGE_SIZE,
    safePage * PAGE_SIZE + PAGE_SIZE,
  )
  const allOnPageSelected =
    pagedRows.length > 0 && pagedRows.every((r) => selected.has(r.keyword))

  function toggleRow(kw: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(kw)) next.delete(kw)
      else next.add(kw)
      return next
    })
  }

  function togglePageAll() {
    setSelected((prev) => {
      const next = new Set(prev)
      if (allOnPageSelected) {
        for (const r of pagedRows) next.delete(r.keyword)
      } else {
        for (const r of pagedRows) next.add(r.keyword)
      }
      return next
    })
  }

  async function exportXlsx() {
    if (!data) return
    const activeMarket =
      data.markets.find((m) => m.key === activeMarketKey) ?? data.markets[0]
    const rowsToExport =
      selected.size > 0
        ? filteredRows.filter((r) => selected.has(r.keyword))
        : filteredRows
    const wb = buildRowsWorkbook(
      rowsToExport,
      [
        { label: "Keyword", value: (r) => r.keyword, width: 36 },
        {
          label: "Intent",
          value: (r) => r.intent ?? "",
          width: 10,
        },
        {
          label: `Volume (${activeMarket.label})`,
          numeric: true,
          value: (r) => r.volumes[activeMarket.key] ?? null,
          width: 16,
        },
        {
          label: "KD",
          numeric: true,
          value: (r) => r.kd,
          width: 10,
        },
        {
          label: "CPC",
          numeric: true,
          numFmt: "$0.00",
          value: (r) => r.cpc,
          width: 10,
        },
        {
          label: "SERP features",
          value: (r) => r.serp_features.join(", "),
          width: 36,
        },
        {
          label: "Source",
          value: (r) => SOURCE_BADGE[r.source],
          width: 10,
        },
      ],
      "Keyword Magic",
    )
    await downloadWorkbook(wb, `keyword-magic-${Date.now()}.xlsx`)
  }

  const seedHeader = data ? (
    <div className="rounded-lg border border-line bg-card px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink-3">
            Seed
          </p>
          <p className="mt-1 font-sans text-[20px] font-semibold text-foreground">
            {data.seed}
          </p>
        </div>
        <div className="text-right">
          <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink-3">
            Volume scope
          </p>
          <div className="mt-1 flex flex-wrap justify-end gap-1">
            {data.markets.map((m) => (
              <Chip
                key={m.key}
                active={m.key === activeMarketKey}
                onClick={() => setActiveMarketKey(m.key)}
                count={m.coverage}
                title={`location_code ${m.location_code} (${m.location_name}) · ${m.coverage} of ${m.queried} keywords returned Ads volume`}
                className="px-2.5 py-1 text-[11px]"
              >
                {m.label}
              </Chip>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-6 border-t border-line pt-3 text-[13px]">
        <span>
          <span className="text-ink-2">Total</span>{" "}
          <span className="font-semibold tabular-nums">
            {data.stats.total.toLocaleString()}
          </span>
        </span>
        <span>
          <span className="text-ink-2">Filtered</span>{" "}
          <span className="font-semibold tabular-nums">
            {filteredRows.length.toLocaleString()}
          </span>
        </span>
        <span>
          <span className="text-ink-2">Avg volume</span>{" "}
          <span className="font-semibold tabular-nums">
            {data.stats.avg_volume == null
              ? "—"
              : data.stats.avg_volume.toLocaleString()}
          </span>
        </span>
        <span>
          <span className="text-ink-2">Avg KD</span>{" "}
          <span className="font-semibold tabular-nums">
            {data.stats.avg_kd == null ? "—" : data.stats.avg_kd}
          </span>
        </span>
      </div>
    </div>
  ) : null

  const clustersCard = data ? (
    <div className="rounded-lg border border-line bg-card px-5 py-4">
      <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink-3">
        Clusters
      </p>

      <div className="mt-2 flex flex-wrap gap-0 border-b border-line">
        {(
          [
            ["all", "All", data.counts.all],
            ["phrase", "Phrase match", data.counts.phrase],
            ["related", "Related", data.counts.related],
            ["pasf", "PASF", data.counts.pasf],
            ["questions", "Questions", data.counts.questions],
          ] as const
        ).map(([mode, label, n]) => (
          <button
            key={mode}
            type="button"
            onClick={() => {
              setMatchMode(mode)
              setPage(0)
            }}
            className={cn(
              "inline-flex items-center gap-1.5 border-b-2 px-3.5 py-2 text-[13px] font-sans",
              matchMode === mode
                ? "border-[#1D9E75] font-medium text-foreground"
                : "border-transparent text-ink-2 hover:text-foreground",
            )}
          >
            {label}
            <span className="tabular-nums text-[12px] text-ink-3">
              {n.toLocaleString()}
            </span>
          </button>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="font-sans text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink-3">
          Filters
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Label
            htmlFor="vol-min"
            className="font-mono text-[10.5px] uppercase tracking-wide text-ink-3"
          >
            Vol ≥
          </Label>
          <Input
            id="vol-min"
            value={volumeMin}
            onChange={(e) => {
              setVolumeMin(e.target.value.replace(/[^\d]/g, ""))
              setPage(0)
            }}
            placeholder="100"
            inputMode="numeric"
            className="h-7 w-20 px-2 py-1 text-[12px]"
          />
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Label
            htmlFor="kd-max"
            className="font-mono text-[10.5px] uppercase tracking-wide text-ink-3"
          >
            KD ≤
          </Label>
          <Input
            id="kd-max"
            value={kdMax}
            onChange={(e) => {
              setKdMax(e.target.value.replace(/[^\d]/g, ""))
              setPage(0)
            }}
            placeholder="40"
            inputMode="numeric"
            className="h-7 w-20 px-2 py-1 text-[12px]"
          />
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="font-mono text-[10.5px] uppercase tracking-wide text-ink-3">
            Intent
          </span>
          {(["I", "N", "C", "T"] as const).map((letter) => {
            const on = intentFilters.has(letter)
            return (
              <button
                key={letter}
                type="button"
                onClick={() => toggleIntent(letter)}
                title={INTENT_LABELS[letter]}
                className={cn(
                  "inline-flex h-6 w-6 items-center justify-center rounded-sm font-mono text-[11px] transition-colors",
                  on
                    ? "bg-info text-white"
                    : "bg-secondary text-ink-2 hover:bg-accent",
                )}
              >
                {letter}
              </button>
            )
          })}
        </span>
        {volumeMin || kdMax || intentFilters.size > 0 || matchMode !== "all" ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={clearFilters}
            className="h-7 px-2 text-[12px]"
          >
            <X className="mr-1 h-3 w-3" />
            Clear
          </Button>
        ) : null}
      </div>
      <p className="mt-3 font-mono text-[10.5px] text-ink-3">
        keyword_suggestions (Phrase) · keyword_ideas (Related) ·
        related_keywords (PASF) · merged + deduped · search_intent for Intent ·
        google_ads/search_volume for per-market volume scope
      </p>
    </div>
  ) : null

  const tableCard = data ? (
    <div className="rounded-lg border border-line bg-card px-5 py-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] max-w-[360px] flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-ink-3" />
          <Input
            value={textFilter}
            onChange={(e) => {
              setTextFilter(e.target.value)
              setPage(0)
            }}
            placeholder="Filter keywords…"
            className="pl-8"
          />
        </div>
        <div className="flex-1" />
        <span className="font-mono text-[11px] text-ink-3">
          {filteredRows.length === data.rows.length
            ? `${data.rows.length.toLocaleString()} rows`
            : `${filteredRows.length.toLocaleString()} of ${data.rows.length.toLocaleString()}`}
        </span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr className="border-b border-line bg-muted/40">
              <th className="px-3 py-2 text-left">
                <input
                  type="checkbox"
                  aria-label="Select page"
                  checked={allOnPageSelected}
                  onChange={togglePageAll}
                />
              </th>
              <th className="px-3 py-2 text-left font-sans text-[11px] font-medium text-ink-2">
                Keyword
              </th>
              <th className="px-3 py-2 text-left font-sans text-[11px] font-medium text-ink-2">
                Int
              </th>
              <th className="px-3 py-2 text-right font-sans text-[11px] font-medium text-ink-2">
                Volume
              </th>
              <th className="px-3 py-2 text-right font-sans text-[11px] font-medium text-ink-2">
                KD
              </th>
              <th className="px-3 py-2 text-right font-sans text-[11px] font-medium text-ink-2">
                CPC
              </th>
              <th className="px-3 py-2 text-left font-sans text-[11px] font-medium text-ink-2">
                SERP feat.
              </th>
              <th className="px-3 py-2 text-left font-sans text-[11px] font-medium text-ink-2">
                Source
              </th>
            </tr>
          </thead>
          <tbody>
            {pagedRows.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-ink-3">
                  No keywords match the current filters.
                </td>
              </tr>
            ) : (
              pagedRows.map((r) => {
                const v = r.volumes[activeMarketKey] ?? null
                return (
                  <tr key={r.keyword} className="border-b border-line/60">
                    <td className="px-3 py-1.5">
                      <input
                        type="checkbox"
                        aria-label={`Select ${r.keyword}`}
                        checked={selected.has(r.keyword)}
                        onChange={() => toggleRow(r.keyword)}
                      />
                    </td>
                    <td className="px-3 py-1.5">{r.keyword}</td>
                    <td className="px-3 py-1.5">
                      {r.intent ? <MiniBadge>{r.intent}</MiniBadge> : <span className="text-ink-3">—</span>}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {v == null ? "—" : v.toLocaleString()}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {r.kd == null ? "—" : r.kd}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {r.cpc == null ? "—" : `$${r.cpc.toFixed(2)}`}
                    </td>
                    <td className="px-3 py-1.5">
                      <SerpFeatureIcons features={r.serp_features} />
                    </td>
                    <td className="px-3 py-1.5">
                      <MiniBadge>{SOURCE_BADGE[r.source]}</MiniBadge>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-3 font-mono text-[10.5px] text-ink-3">
        ranked from keyword_suggestions + keyword_ideas + related_keywords +
        search_intent · click a column header to sort (coming soon)
      </p>
    </div>
  ) : null

  const footerControls = data ? (
    <div className="flex flex-wrap items-center justify-between gap-3 px-1">
      <div className="flex items-center gap-3">
        <span className="text-[13px] text-ink-2">
          <span className="font-semibold text-foreground tabular-nums">
            {selected.size}
          </span>{" "}
          selected
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={exportXlsx}
        >
          <Download className="mr-1.5 h-3.5 w-3.5" />
          Export to xlsx
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled
          title="Coming soon"
        >
          <FilePlus className="mr-1.5 h-3.5 w-3.5" />
          Send to strategy doc
        </Button>
      </div>
      <div className="flex items-center gap-2 text-[12px] text-ink-2">
        <span>
          {filteredRows.length === 0
            ? "0 of 0"
            : `${(safePage * PAGE_SIZE + 1).toLocaleString()}–${Math.min(
                (safePage + 1) * PAGE_SIZE,
                filteredRows.length,
              ).toLocaleString()} of ${filteredRows.length.toLocaleString()}`}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={safePage === 0}
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          className="h-7 px-2"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={safePage >= totalPages - 1}
          onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
          className="h-7 px-2"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  ) : null

  return (
    <ToolShell
      category="Keywords"
      title={tool.label}
      description={tool.description}
      endpoints={tool.endpoints}
      meta={meta}
      form={
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_280px]">
            <div className="space-y-1.5">
              <Label htmlFor="seed">Seed keyword</Label>
              <Input
                id="seed"
                value={seed}
                onChange={(e) => setSeed(e.target.value)}
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
                {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Run Keyword Magic
              </Button>
            </div>
          </div>
          <div className="space-y-2 border-t border-dashed border-line pt-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[240px] flex-1">
                <MarketPicker
                  value={cityPicker}
                  onChange={setCityPicker}
                  label="Add city volume scope (optional)"
                  inputId="city-picker"
                  helpText="Adds a chip to the volume-scope row. Each city = one extra google_ads/search_volume call."
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
                Add city
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
        </form>
      }
      results={
        error ? (
          <ToolError message={error} />
        ) : !data ? (
          <div className="rounded-lg border border-dashed border-line bg-muted/30 px-6 py-10 text-center">
            <p className="font-serif text-[13.5px] text-ink-3">
              Enter a seed keyword above to fetch suggestions, ideas, related
              terms, intent, and per-market volume.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {seedHeader}
            {clustersCard}
            {tableCard}
            {footerControls}
          </div>
        )
      }
    />
  )
}
