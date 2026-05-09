"use client"

import { useCallback, useMemo, useState } from "react"
import { DownloadIcon, ArrowUpDown, ArrowDown, ArrowUp } from "lucide-react"
import { LocationAutocomplete } from "@/components/LocationAutocomplete"
import { PageHeader } from "@/components/PageHeader"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import { useChatPageContext } from "@/lib/chat-context"
import { cn } from "@/lib/utils"
import type { DfsLabsLocation, KeywordResult } from "@/lib/types"

type Stage =
  | "claude-seeds"
  | "dfs-ideas"
  | "dfs-volume"
  | "dfs-serp-rank"
  | "done"

type RankedKeyword = KeywordResult & { currentRanking?: number }

type LocationResult = {
  location: DfsLabsLocation
  rows: RankedKeyword[]
  truncated: number
  /** SERP probe failed for this location entirely; ranks are absent. */
  rankProbeFailed: boolean
}

type Phase =
  | { status: "idle" }
  | { status: "running"; stage: Stage; note?: string }
  | {
      status: "done"
      results: LocationResult[]
      domain: string
      seeds: string[]
    }
  | { status: "error"; message: string }

type SortKey =
  | "keyword"
  | "search_volume"
  | "cpc"
  | "competition_level"
  | "currentRanking"

interface SortState {
  key: SortKey
  direction: "asc" | "desc"
}

const DEFAULT_MAX_KEYWORDS = 300
const MAX_KEYWORDS_CEILING = 1000

function dedupeByKeyword(rows: KeywordResult[]): KeywordResult[] {
  const seen = new Map<string, KeywordResult>()
  for (const r of rows) {
    const key = r.keyword.trim().toLowerCase()
    if (!key) continue
    const existing = seen.get(key)
    if (!existing) {
      seen.set(key, r)
      continue
    }
    seen.set(key, {
      ...existing,
      ...Object.fromEntries(
        Object.entries(r).filter(([, v]) => v !== undefined && v !== null),
      ),
    })
  }
  return Array.from(seen.values())
}

function stageLabel(stage: Stage): string {
  switch (stage) {
    case "claude-seeds":
      return "Asking Claude for seed keywords from the services context…"
    case "dfs-ideas":
      return "Fetching keyword ideas & suggestions from DataForSEO…"
    case "dfs-volume":
      return "Fetching city-level search volume per location…"
    case "dfs-serp-rank":
      return "Probing live SERPs for current rankings per location…"
    case "done":
      return "Done."
  }
}

function stageIndex(stage: Stage): number {
  return [
    "claude-seeds",
    "dfs-ideas",
    "dfs-volume",
    "dfs-serp-rank",
    "done",
  ].indexOf(stage)
}

function csvEscape(value: unknown): string {
  if (value == null) return ""
  const s = String(value)
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

function buildCsv(rows: RankedKeyword[]): string {
  const headers = [
    "Keyword",
    "Volume (city)",
    "CPC",
    "Competition",
    "Current Ranking",
  ]
  const lines = [headers.join(",")]
  for (const r of rows) {
    const cols = [
      csvEscape(r.keyword),
      csvEscape(r.search_volume ?? ""),
      csvEscape(r.cpc ?? ""),
      csvEscape(r.competition_level ?? ""),
      csvEscape(r.currentRanking ?? ""),
    ]
    lines.push(cols.join(","))
  }
  return lines.join("\n")
}

function downloadCsv(
  rows: RankedKeyword[],
  slugSource: string,
  locationLabel: string,
) {
  const csv = buildCsv(rows)
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  const slug = slugSource
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
  const locSlug = locationLabel
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
  const stamp = new Date().toISOString().slice(0, 10)
  a.href = url
  a.download = `${slug || "subject"}-keywords-${locSlug || "location"}-${stamp}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function normalizeDomainInput(raw: string): string {
  let d = raw.trim().toLowerCase()
  if (!d) return ""
  d = d.replace(/^https?:\/\//, "")
  d = d.replace(/^www\./, "")
  d = d.replace(/\/.*$/, "")
  return d
}

const DOMAIN_REGEX = /^[\w-]+(\.[\w-]+)+$/

function locationKeyOf(loc: DfsLabsLocation): string {
  return String(loc.location_code)
}

/** Short label for tabs / progress: "Atlanta" from "Atlanta,Georgia,…". */
function shortLocationLabel(loc: DfsLabsLocation): string {
  const first = loc.location_name.split(",")[0]?.trim()
  return first || loc.location_name
}

async function fetchJson<T>(
  url: string,
  init: RequestInit,
  friendly: string,
): Promise<T> {
  const response = await fetch(url, init)
  const body = (await response.json().catch(() => ({}))) as {
    error?: string
    code?: string
  } & T
  if (!response.ok) {
    const msg = body.error ?? `${friendly} failed (${response.status})`
    const err = new Error(msg) as Error & { code?: string }
    if (body.code) err.code = body.code
    throw err
  }
  return body
}

export default function KeywordResearchPage() {
  const [domainInput, setDomainInput] = useState("")
  const [services, setServices] = useState("")
  const [selectedLocations, setSelectedLocations] = useState<
    DfsLabsLocation[]
  >([])
  const [maxKeywordsInput, setMaxKeywordsInput] = useState<string>(
    String(DEFAULT_MAX_KEYWORDS),
  )
  const [phase, setPhase] = useState<Phase>({ status: "idle" })
  const [activeLocationKey, setActiveLocationKey] = useState<string | null>(
    null,
  )
  const [sort, setSort] = useState<SortState>({
    key: "search_volume",
    direction: "desc",
  })

  const addLocation = useCallback((loc: DfsLabsLocation) => {
    setSelectedLocations((prev) =>
      prev.some((l) => l.location_code === loc.location_code)
        ? prev
        : [...prev, loc],
    )
  }, [])

  const removeLocation = useCallback((code: number) => {
    setSelectedLocations((prev) =>
      prev.filter((l) => l.location_code !== code),
    )
  }, [])

  const normalizedDomain = useMemo(
    () => normalizeDomainInput(domainInput),
    [domainInput],
  )
  const domainValid = useMemo(
    () => DOMAIN_REGEX.test(normalizedDomain),
    [normalizedDomain],
  )
  const servicesValid = services.trim().length > 0
  const ready =
    domainValid && servicesValid && selectedLocations.length > 0

  const running = phase.status === "running"

  useChatPageContext("keyword-research", {
    tab: "Keyword Research",
    summary: [
      normalizedDomain
        ? `Domain: ${normalizedDomain}.`
        : "No domain entered.",
      services.trim().length > 0
        ? `${services.trim().length} chars of services context.`
        : "No services context.",
      selectedLocations.length > 0
        ? `${selectedLocations.length} location(s) selected.`
        : "No locations selected.",
      phase.status === "done"
        ? `Run complete: ${phase.results.length} location result set(s) for ${phase.domain}.`
        : phase.status === "running"
          ? `Running: ${phase.stage}.`
          : `Phase: ${phase.status}.`,
    ].join(" "),
    data: {
      domain: normalizedDomain || null,
      locations: selectedLocations.map((l) => ({
        code: l.location_code,
        name: l.location_name,
      })),
      phase: phase.status,
      results:
        phase.status === "done"
          ? {
              seeds: phase.seeds,
              perLocation: phase.results.map((r) => ({
                location: r.location.location_name,
                keywordCount: r.rows.length,
                truncated: r.truncated,
                rankProbeFailed: r.rankProbeFailed,
                topKeywords: r.rows.slice(0, 15).map((k) => ({
                  keyword: k.keyword,
                  volume: k.search_volume,
                  currentRanking: k.currentRanking,
                })),
              })),
            }
          : null,
    },
  })

  const handleRun = useCallback(async () => {
    if (!ready) return

    const parsedMax = parseInt(maxKeywordsInput, 10)
    const maxKeywords =
      Number.isFinite(parsedMax) && parsedMax > 0
        ? Math.min(parsedMax, MAX_KEYWORDS_CEILING)
        : DEFAULT_MAX_KEYWORDS

    const primaryLocationCode = selectedLocations[0].location_code

    // ── Stage 1: Claude generates seed keywords ──────────────────────────
    setPhase({ status: "running", stage: "claude-seeds" })
    let seeds: string[]
    try {
      const body = await fetchJson<{ seeds: string[] }>(
        "/api/claude/keyword-seeds",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            services,
            domain: normalizedDomain,
            locations: selectedLocations.map((l) => l.location_name),
          }),
        },
        "Claude seed generation",
      )
      seeds = body.seeds ?? []
      if (seeds.length === 0) {
        throw new Error("Claude returned no seed keywords.")
      }
    } catch (err) {
      setPhase({
        status: "error",
        message:
          err instanceof Error ? err.message : "Seed generation failed",
      })
      return
    }

    // ── Stage 2: ideas + suggestions per seed ────────────────────────────
    setPhase({
      status: "running",
      stage: "dfs-ideas",
      note: `${seeds.length} seed${seeds.length === 1 ? "" : "s"}`,
    })
    const dfsCombined: KeywordResult[] = []
    try {
      const calls: Promise<{ results: KeywordResult[] }>[] = []
      for (const seed of seeds) {
        calls.push(
          fetchJson<{ results: KeywordResult[] }>(
            "/api/dataforseo/keywords",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                mode: "ideas",
                seed,
                locationCode: primaryLocationCode,
                limit: 50,
              }),
            },
            `DataForSEO ideas for "${seed}"`,
          ),
        )
        calls.push(
          fetchJson<{ results: KeywordResult[] }>(
            "/api/dataforseo/keywords",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                mode: "suggestions",
                seed,
                locationCode: primaryLocationCode,
                limit: 50,
              }),
            },
            `DataForSEO suggestions for "${seed}"`,
          ),
        )
      }
      const settled = await Promise.allSettled(calls)
      const failures: string[] = []
      for (const s of settled) {
        if (s.status === "fulfilled") {
          dfsCombined.push(...(s.value.results ?? []))
        } else {
          failures.push(
            s.reason instanceof Error ? s.reason.message : String(s.reason),
          )
        }
      }
      if (dfsCombined.length === 0) {
        throw new Error(
          failures.length > 0
            ? `All DataForSEO calls failed. First error: ${failures[0]}`
            : "DataForSEO returned no keyword ideas. Refine the services context and try again.",
        )
      }
    } catch (err) {
      setPhase({
        status: "error",
        message:
          err instanceof Error ? err.message : "DataForSEO request failed",
      })
      return
    }
    const deduped = dedupeByKeyword(dfsCombined)

    // ── Stage 3: per-location volume (parallel) ──────────────────────────
    setPhase({
      status: "running",
      stage: "dfs-volume",
      note: `${selectedLocations.length} location${
        selectedLocations.length === 1 ? "" : "s"
      }`,
    })
    type EnrichedByLoc = Map<string, KeywordResult[]>
    const enrichedByLoc: EnrichedByLoc = new Map()
    await Promise.all(
      selectedLocations.map(async (loc) => {
        const key = locationKeyOf(loc)
        if (loc.location_type === "Country") {
          enrichedByLoc.set(key, deduped)
          return
        }
        try {
          const keywordList = deduped.map((r) => r.keyword).slice(0, 1000)
          const volBody = await fetchJson<{ results: KeywordResult[] }>(
            "/api/dataforseo/keywords",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                mode: "volume",
                keywords: keywordList,
                locationCode: loc.location_code,
              }),
            },
            `DataForSEO search volume for ${loc.location_name}`,
          )
          const byKw = new Map(
            (volBody.results ?? []).map((r) => [r.keyword.toLowerCase(), r]),
          )
          const enriched = deduped.map((r) => {
            const v = byKw.get(r.keyword.toLowerCase())
            if (!v) return r
            return {
              ...r,
              search_volume: v.search_volume ?? r.search_volume,
              cpc: v.cpc ?? r.cpc,
              competition: v.competition ?? r.competition,
              competition_level: v.competition_level ?? r.competition_level,
            }
          })
          enrichedByLoc.set(key, enriched)
        } catch (err) {
          console.warn(
            `[keyword-research] volume fetch failed for ${loc.location_name}:`,
            err,
          )
          enrichedByLoc.set(key, deduped)
        }
      }),
    )

    // Per-location surfacing: sort by volume desc and take top maxKeywords.
    // The remaining keywords are dropped — we don't want to pay for SERP rank
    // probes against zero-volume long-tail noise. Track the drop count so the
    // UI can disclose it.
    type SurfacedOut = { rows: KeywordResult[]; truncated: number }
    const surfacedByLoc = new Map<string, SurfacedOut>()
    for (const loc of selectedLocations) {
      const key = locationKeyOf(loc)
      const enriched = enrichedByLoc.get(key) ?? deduped
      const sorted = enriched
        .slice()
        .sort(
          (a, b) =>
            (b.search_volume ?? 0) - (a.search_volume ?? 0),
        )
      const surfaced = sorted.slice(0, maxKeywords)
      const truncated = Math.max(0, sorted.length - surfaced.length)
      surfacedByLoc.set(key, { rows: surfaced, truncated })
    }

    // ── Stage 4: per-location SERP rank probes (parallel) ────────────────
    setPhase({
      status: "running",
      stage: "dfs-serp-rank",
      note: `${selectedLocations.length} location${
        selectedLocations.length === 1 ? "" : "s"
      }`,
    })
    type RankRow = { keyword: string; position: number | null }
    type RankOut = { ranks: Map<string, number>; failed: boolean }
    const rankByLoc = new Map<string, RankOut>()
    await Promise.all(
      selectedLocations.map(async (loc) => {
        const key = locationKeyOf(loc)
        const surfaced = surfacedByLoc.get(key)
        if (!surfaced || surfaced.rows.length === 0) {
          rankByLoc.set(key, { ranks: new Map(), failed: false })
          return
        }
        const keywords = surfaced.rows.map((r) => r.keyword)
        try {
          const body = await fetchJson<{ rows: RankRow[] }>(
            "/api/dataforseo/serp-rank",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                keywords,
                locationCode: loc.location_code,
                domain: normalizedDomain,
              }),
            },
            `SERP rank probes for ${loc.location_name}`,
          )
          const ranks = new Map<string, number>()
          for (const row of body.rows ?? []) {
            if (row.position != null) {
              ranks.set(row.keyword.toLowerCase(), row.position)
            }
          }
          rankByLoc.set(key, { ranks, failed: false })
        } catch (err) {
          console.warn(
            `[keyword-research] SERP rank probe failed for ${loc.location_name}:`,
            err,
          )
          rankByLoc.set(key, { ranks: new Map(), failed: true })
        }
      }),
    )

    // ── Assemble per-location results ────────────────────────────────────
    const results: LocationResult[] = []
    for (const loc of selectedLocations) {
      const key = locationKeyOf(loc)
      const surfaced = surfacedByLoc.get(key)
      if (!surfaced) continue
      const rankOut = rankByLoc.get(key) ?? { ranks: new Map(), failed: false }
      const rows: RankedKeyword[] = surfaced.rows.map((r) => ({
        ...r,
        currentRanking: rankOut.ranks.get(r.keyword.toLowerCase()),
      }))
      results.push({
        location: loc,
        rows,
        truncated: surfaced.truncated,
        rankProbeFailed: rankOut.failed,
      })
    }

    setPhase({
      status: "done",
      results,
      domain: normalizedDomain,
      seeds,
    })
    setActiveLocationKey(locationKeyOf(selectedLocations[0]))
  }, [
    ready,
    services,
    normalizedDomain,
    selectedLocations,
    maxKeywordsInput,
  ])

  const results = useMemo<LocationResult[]>(
    () => (phase.status === "done" ? phase.results : []),
    [phase],
  )

  const activeResult = useMemo<LocationResult | null>(() => {
    if (results.length === 0) return null
    if (activeLocationKey) {
      const hit = results.find(
        (r) => locationKeyOf(r.location) === activeLocationKey,
      )
      if (hit) return hit
    }
    return results[0]
  }, [results, activeLocationKey])

  const activeRows = useMemo<RankedKeyword[]>(
    () => activeResult?.rows ?? [],
    [activeResult],
  )

  const sorted = useMemo(() => {
    const copy = activeRows.slice()
    const { key, direction } = sort
    const sign = direction === "asc" ? 1 : -1
    copy.sort((a, b) => {
      const av = a[key]
      const bv = b[key]
      // currentRanking is special: lower is better, and undefined means
      // "not ranked in top 100" — those should sort to the bottom regardless
      // of direction so the ranked keywords stay grouped together.
      if (key === "currentRanking") {
        const aMissing = av == null
        const bMissing = bv == null
        if (aMissing && bMissing) return 0
        if (aMissing) return 1
        if (bMissing) return -1
        return sign * ((av as number) - (bv as number))
      }
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === "number" && typeof bv === "number") {
        return sign * (av - bv)
      }
      return sign * String(av).localeCompare(String(bv))
    })
    return copy
  }, [activeRows, sort])

  const toggleSort = useCallback((key: SortKey) => {
    setSort((prev) => {
      if (prev.key !== key) {
        const defaultAsc = key === "currentRanking" || key === "keyword"
        return { key, direction: defaultAsc ? "asc" : "desc" }
      }
      return { key, direction: prev.direction === "asc" ? "desc" : "asc" }
    })
  }, [])

  const csvSlugSource = normalizedDomain || "subject"

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Tool / Keyword Research"
        title="Keyword Research"
        tail="— score the long list."
        subtitle={
          <>
            Have{" "}
            <b className="font-sans font-extrabold not-italic text-foreground">
              Claude
            </b>{" "}
            generate seed keywords from a services description, then pull{" "}
            <b className="font-sans font-extrabold not-italic text-foreground">
              DataForSEO
            </b>{" "}
            keyword ideas, suggestions, and city-level search volume per
            location, with live SERP rank probes against the target domain.
          </>
        }
      />

      <section className="space-y-4 rounded-lg border p-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="domain">
            Domain <span className="text-destructive">*</span>
          </Label>
          <Input
            id="domain"
            type="text"
            placeholder="example.com"
            value={domainInput}
            onChange={(e) => setDomainInput(e.target.value)}
            disabled={running}
          />
          <p className="text-xs text-muted-foreground">
            Bare hostname or full URL — used as the target for live SERP rank
            probes per location.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="services">
            Services / context{" "}
            <span className="text-destructive">*</span>
          </Label>
          <Textarea
            id="services"
            placeholder="e.g. Residential plumbing — water heaters, drain cleaning, emergency repair, sewer line replacement."
            value={services}
            onChange={(e) => setServices(e.target.value)}
            disabled={running}
            className="min-h-[100px]"
          />
          <p className="text-xs text-muted-foreground">
            Claude reads this to produce seed keywords that drive the
            DataForSEO expansion. Be specific — one or two sentences naming
            the actual services beats a generic blurb.
          </p>
        </div>
      </section>

      <section className="space-y-3 rounded-lg border p-4">
        <LocationAutocomplete
          selected={selectedLocations}
          onAdd={addLocation}
          onRemove={removeLocation}
          disabled={running}
          label="DataForSEO locations — one results tab per location"
          helpText={
            selectedLocations.length === 0 ? (
              <>
                Start typing to find cities, counties, or states in
                DataForSEO&apos;s Google Ads taxonomy. Each location you add
                gets its own results tab with location-specific search
                volume and current SERP rank for the target domain.
              </>
            ) : (
              <>
                {selectedLocations.length} location
                {selectedLocations.length === 1 ? "" : "s"} selected. Each
                becomes its own tab in the results.
              </>
            )
          }
        />
      </section>

      <section className="space-y-3 rounded-lg border p-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="max-keywords">Max keywords to surface</Label>
          <input
            id="max-keywords"
            type="number"
            min={10}
            max={MAX_KEYWORDS_CEILING}
            step={10}
            value={maxKeywordsInput}
            onChange={(e) => setMaxKeywordsInput(e.target.value)}
            disabled={running}
            className="h-9 w-[140px] rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <p className="text-xs text-muted-foreground">
            How many keywords to surface per location (sorted by city-level
            volume, descending). Each surfaced keyword gets a live SERP rank
            probe per location, so this knob is the main cost lever. Default{" "}
            {DEFAULT_MAX_KEYWORDS}, hard-capped at {MAX_KEYWORDS_CEILING}.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={handleRun} disabled={running || !ready}>
            {running ? "Running…" : "Run Research"}
          </Button>
          <StageProgress phase={phase} />
        </div>
      </section>

      <PhaseError phase={phase} />

      {phase.status === "done" && results.length > 0 ? (
        <section className="space-y-3">
          <SeedSummary seeds={phase.seeds} />
          <ColumnLegend />
          <Tabs
            value={
              activeResult
                ? locationKeyOf(activeResult.location)
                : locationKeyOf(results[0].location)
            }
            onValueChange={(v) => setActiveLocationKey(v)}
          >
            <TabsList variant="line" className="flex flex-wrap">
              {results.map((r) => (
                <TabsTrigger
                  key={locationKeyOf(r.location)}
                  value={locationKeyOf(r.location)}
                >
                  {shortLocationLabel(r.location)}
                </TabsTrigger>
              ))}
            </TabsList>
            {results.map((r) => {
              const isActive =
                activeResult != null &&
                locationKeyOf(activeResult.location) ===
                  locationKeyOf(r.location)
              return (
                <TabsContent
                  key={locationKeyOf(r.location)}
                  value={locationKeyOf(r.location)}
                >
                  {isActive ? (
                    <LocationResultPanel
                      result={r}
                      domain={phase.domain}
                      sorted={sorted}
                      totalRows={activeRows.length}
                      sort={sort}
                      onToggleSort={toggleSort}
                      onExport={() =>
                        downloadCsv(
                          sorted,
                          csvSlugSource,
                          shortLocationLabel(r.location),
                        )
                      }
                    />
                  ) : null}
                </TabsContent>
              )
            })}
          </Tabs>
        </section>
      ) : null}
    </div>
  )
}

function SeedSummary({ seeds }: { seeds: string[] }) {
  if (seeds.length === 0) return null
  return (
    <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">
        Claude seed keywords ({seeds.length}):
      </span>{" "}
      {seeds.join(", ")}
    </div>
  )
}

function LocationResultPanel({
  result,
  domain,
  sorted,
  totalRows,
  sort,
  onToggleSort,
  onExport,
}: {
  result: LocationResult
  domain: string
  sorted: RankedKeyword[]
  totalRows: number
  sort: SortState
  onToggleSort: (k: SortKey) => void
  onExport: () => void
}) {
  return (
    <div className="space-y-3 pt-3">
      <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <span>
          Location:{" "}
          <span className="font-medium text-foreground">
            {result.location.location_name}
          </span>
        </span>
        <span>·</span>
        <span>
          Domain probed:{" "}
          <span className="font-mono text-foreground">{domain}</span>
        </span>
        {result.rankProbeFailed ? (
          <span className="ml-auto text-destructive">
            SERP rank probes failed for this location — Current Ranking column
            is empty.
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="ml-auto flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            {sorted.length} of {totalRows} keywords
            {result.truncated > 0
              ? ` · ${result.truncated} dropped past the surface cap`
              : ""}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={onExport}
            disabled={sorted.length === 0}
          >
            <DownloadIcon className="mr-2 size-4" />
            Export CSV
          </Button>
        </div>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableHead
                sortKey="keyword"
                sort={sort}
                onToggle={onToggleSort}
              >
                Keyword
              </SortableHead>
              <SortableHead
                sortKey="search_volume"
                sort={sort}
                onToggle={onToggleSort}
                numeric
              >
                Volume (city)
              </SortableHead>
              <SortableHead
                sortKey="cpc"
                sort={sort}
                onToggle={onToggleSort}
                numeric
              >
                CPC
              </SortableHead>
              <SortableHead
                sortKey="competition_level"
                sort={sort}
                onToggle={onToggleSort}
              >
                Competition
              </SortableHead>
              <SortableHead
                sortKey="currentRanking"
                sort={sort}
                onToggle={onToggleSort}
                numeric
              >
                Current Ranking
              </SortableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="text-center text-sm text-muted-foreground"
                >
                  No keywords to display.
                </TableCell>
              </TableRow>
            ) : (
              sorted.map((r) => (
                <TableRow key={r.keyword}>
                  <TableCell className="font-medium">{r.keyword}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.search_volume != null
                      ? r.search_volume.toLocaleString()
                      : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.cpc != null ? `$${r.cpc.toFixed(2)}` : "—"}
                  </TableCell>
                  <TableCell>
                    <CompetitionLabel level={r.competition_level} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <CurrentRankingCell value={r.currentRanking} />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function ColumnLegend() {
  return (
    <details className="group rounded-lg border bg-card p-0 text-sm">
      <summary className="cursor-pointer list-none px-4 py-2.5 text-xs font-medium text-muted-foreground hover:text-foreground">
        <span className="inline-flex items-center gap-2">
          <span className="transition-transform group-open:rotate-90">▸</span>
          How these columns work
        </span>
      </summary>
      <dl className="space-y-3 border-t px-4 py-3 text-xs leading-relaxed">
        <div>
          <dt className="font-medium text-foreground">Keyword</dt>
          <dd className="text-muted-foreground">
            Candidate keyword from DataForSEO&apos;s{" "}
            <code className="font-mono">keyword_ideas</code> +{" "}
            <code className="font-mono">keyword_suggestions</code> endpoints,
            seeded by Claude from the services context. The candidate pool is
            shared across location tabs because those endpoints are
            country-level only; locations differentiate downstream on volume
            and current rank.
          </dd>
        </div>
        <div>
          <dt className="font-medium text-foreground">Volume (city)</dt>
          <dd className="text-muted-foreground">
            Monthly search volume from DataForSEO&apos;s{" "}
            <code className="font-mono">google_ads/search_volume</code>{" "}
            endpoint, scoped to <strong>this tab&apos;s location</strong>{" "}
            (the only DataForSEO endpoint that supports city-level location
            codes). Different tabs show different numbers for the same
            keyword.
          </dd>
        </div>
        <div>
          <dt className="font-medium text-foreground">CPC</dt>
          <dd className="text-muted-foreground">
            Average cost-per-click from the same Google Ads search-volume
            payload. Useful as a rough proxy for commercial intent and
            advertiser competition.
          </dd>
        </div>
        <div>
          <dt className="font-medium text-foreground">Competition</dt>
          <dd className="text-muted-foreground">
            DataForSEO&apos;s HIGH / MEDIUM / LOW bucket from the Google Ads
            payload. Reflects paid-search competition in the location, not
            organic ranking difficulty.
          </dd>
        </div>
        <div>
          <dt className="font-medium text-foreground">Current Ranking</dt>
          <dd className="text-muted-foreground">
            Live SERP probe via{" "}
            <code className="font-mono">/v3/serp/google/organic/live/advanced</code>{" "}
            for each surfaced keyword in this tab&apos;s city. Shows the
            target domain&apos;s 1-indexed position in organic results
            (top 100). Empty when the domain isn&apos;t in the top 100.
          </dd>
        </div>
      </dl>
    </details>
  )
}

function StageProgress({ phase }: { phase: Phase }) {
  if (phase.status !== "running") return null
  const stages: Stage[] = [
    "claude-seeds",
    "dfs-ideas",
    "dfs-volume",
    "dfs-serp-rank",
  ]
  const currentIdx = stageIndex(phase.stage)
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm text-muted-foreground" aria-live="polite">
        {stageLabel(phase.stage)}
        {phase.note ? ` (${phase.note})` : ""}
      </span>
      <div className="flex gap-1" aria-hidden>
        {stages.map((s, i) => (
          <div
            key={s}
            className={cn(
              "h-1 w-12 rounded-full",
              i < currentIdx
                ? "bg-primary"
                : i === currentIdx
                  ? "animate-pulse bg-primary"
                  : "bg-muted",
            )}
          />
        ))}
      </div>
    </div>
  )
}

function PhaseError({ phase }: { phase: Phase }) {
  if (phase.status !== "error") return null
  return (
    <p
      className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
      role="alert"
    >
      {phase.message}
    </p>
  )
}

function SortableHead({
  sortKey,
  sort,
  onToggle,
  numeric,
  children,
}: {
  sortKey: SortKey
  sort: SortState
  onToggle: (k: SortKey) => void
  numeric?: boolean
  children: React.ReactNode
}) {
  const active = sort.key === sortKey
  const Icon = !active ? ArrowUpDown : sort.direction === "asc" ? ArrowUp : ArrowDown
  return (
    <TableHead className={numeric ? "text-right" : undefined}>
      <button
        type="button"
        onClick={() => onToggle(sortKey)}
        className={cn(
          "inline-flex items-center gap-1 text-xs font-medium hover:text-foreground",
          active ? "text-foreground" : "text-muted-foreground",
          numeric ? "ml-auto" : "",
        )}
      >
        {children}
        <Icon className="size-3" />
      </button>
    </TableHead>
  )
}

function CompetitionLabel({
  level,
}: {
  level: "HIGH" | "MEDIUM" | "LOW" | undefined
}) {
  if (!level) return <span className="text-xs text-muted-foreground">—</span>
  const variant: "default" | "secondary" | "outline" =
    level === "HIGH" ? "default" : level === "MEDIUM" ? "secondary" : "outline"
  return (
    <Badge variant={variant} className="capitalize">
      {level.toLowerCase()}
    </Badge>
  )
}

function CurrentRankingCell({ value }: { value: number | undefined }) {
  if (value == null) {
    return (
      <span
        className="text-xs text-muted-foreground"
        title="Domain not found in the top 100 organic results for this keyword/location"
      >
        —
      </span>
    )
  }
  // Top 10 = green, top 30 = blue, beyond = muted.
  const variant: "default" | "secondary" | "outline" =
    value <= 10 ? "default" : value <= 30 ? "secondary" : "outline"
  return <Badge variant={variant}>{value}</Badge>
}
