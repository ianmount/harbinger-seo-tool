"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { DownloadIcon, ArrowUpDown, ArrowDown, ArrowUp } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useSelectedPartner } from "@/lib/use-selected-partner"
import { findBestGscSite } from "@/lib/gsc-site-match"
import {
  findSuggestedDfsLocation,
  parseLocationCities,
  US_DFS_LOCATIONS,
} from "@/lib/locations"
import { cn } from "@/lib/utils"
import type {
  GSCSiteInfo,
  GSCTopQueryRow,
  KeywordCluster,
  KeywordIntent,
  KeywordRecommendation,
  KeywordResult,
  Partner,
  ScoredKeyword,
} from "@/lib/types"

type Stage =
  | "gsc"
  | "dfs-ideas"
  | "dfs-difficulty"
  | "claude"
  | "done"

type Phase =
  | { status: "idle" }
  | { status: "running"; stage: Stage; note?: string }
  | { status: "done"; rows: ScoredKeyword[]; clusters: KeywordCluster[]; truncated: number }
  | { status: "error"; message: string }

type SortKey =
  | "keyword"
  | "cluster"
  | "search_volume"
  | "keyword_difficulty"
  | "fitScore"
  | "intent"
  | "recommendation"

interface SortState {
  key: SortKey
  direction: "asc" | "desc"
}

const FILTER_ALL = "__all__"
const MAX_SEEDS = 6

function parseSeedsFromTextarea(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function generateDefaultSeeds(partner: Partner): string[] {
  const services = partner.services
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 3)
  const cities = parseLocationCities(partner.serviceAreas)
  const primaryCity = cities[0]

  const seeds: string[] = []
  for (const service of services) {
    if (primaryCity) {
      seeds.push(`${service} in ${primaryCity}`)
      seeds.push(`${service} near me`)
    } else {
      seeds.push(service)
    }
  }
  return Array.from(new Set(seeds)).slice(0, MAX_SEEDS)
}

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
    // Merge: prefer non-null values from whichever source has them.
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
    case "gsc":
      return "Pulling Google Search Console baseline…"
    case "dfs-ideas":
      return "Fetching keyword ideas & suggestions from DataForSEO…"
    case "dfs-difficulty":
      return "Measuring keyword difficulty…"
    case "claude":
      return "Clustering and scoring with Claude…"
    case "done":
      return "Done."
  }
}

function stageIndex(stage: Stage): number {
  return ["gsc", "dfs-ideas", "dfs-difficulty", "claude", "done"].indexOf(stage)
}

function csvEscape(value: unknown): string {
  if (value == null) return ""
  const s = String(value)
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

function buildCsv(rows: ScoredKeyword[]): string {
  const headers = [
    "Keyword",
    "Cluster",
    "Volume",
    "Difficulty",
    "Fit Score",
    "Intent",
    "Recommendation",
    "CPC",
    "Competition",
  ]
  const lines = [headers.join(",")]
  for (const r of rows) {
    lines.push(
      [
        csvEscape(r.keyword),
        csvEscape(r.cluster),
        csvEscape(r.search_volume ?? ""),
        csvEscape(r.keyword_difficulty ?? ""),
        csvEscape(r.fitScore),
        csvEscape(r.intent),
        csvEscape(r.recommendation),
        csvEscape(r.cpc ?? ""),
        csvEscape(r.competition_level ?? ""),
      ].join(","),
    )
  }
  return lines.join("\n")
}

function downloadCsv(rows: ScoredKeyword[], partnerName: string) {
  const csv = buildCsv(rows)
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  const slug = partnerName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
  const stamp = new Date().toISOString().slice(0, 10)
  a.href = url
  a.download = `${slug || "partner"}-keywords-${stamp}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
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

const LOCATION_CUSTOM = "__custom__"

export default function KeywordResearchPage() {
  const { partner, loading: partnerLoading, error: partnerError } =
    useSelectedPartner()
  const [seedsText, setSeedsText] = useState("")
  const [phase, setPhase] = useState<Phase>({ status: "idle" })
  const [clusterFilter, setClusterFilter] = useState<string>(FILTER_ALL)
  const [recFilter, setRecFilter] = useState<string>(FILTER_ALL)
  const [sort, setSort] = useState<SortState>({
    key: "fitScore",
    direction: "desc",
  })
  const [locationChoice, setLocationChoice] = useState<string>("United States")
  const [customLocation, setCustomLocation] = useState<string>("")

  useEffect(() => {
    // Reset state when partner changes. The URL param drives partner selection,
    // so this is a sync from external state into component state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPhase({ status: "idle" })
    setClusterFilter(FILTER_ALL)
    setRecFilter(FILTER_ALL)
    setSeedsText("")
    setCustomLocation("")
    setLocationChoice(
      partner ? findSuggestedDfsLocation(partner.serviceAreas) : "United States",
    )
  }, [partner?.id, partner])

  const defaultSeeds = useMemo(
    () => (partner ? generateDefaultSeeds(partner) : []),
    [partner],
  )

  const effectiveLocation = useMemo(() => {
    if (locationChoice === LOCATION_CUSTOM) return customLocation.trim()
    return locationChoice
  }, [locationChoice, customLocation])

  const effectiveSeeds = useMemo(() => {
    const fromText = parseSeedsFromTextarea(seedsText)
    return fromText.length > 0 ? fromText : defaultSeeds
  }, [seedsText, defaultSeeds])

  const running = phase.status === "running"

  const handleRun = useCallback(async () => {
    if (!partner) return
    const seeds = effectiveSeeds.slice(0, MAX_SEEDS)
    if (seeds.length === 0) {
      setPhase({
        status: "error",
        message:
          "No seeds available — enter at least one seed keyword in the textarea or make sure the partner has services listed in Airtable.",
      })
      return
    }
    if (!effectiveLocation) {
      setPhase({
        status: "error",
        message:
          "Pick a location, or enter a custom DataForSEO location name (e.g. \"Oklahoma City,Oklahoma,United States\").",
      })
      return
    }

    const location = effectiveLocation

    // Stage 1: GSC (non-fatal — continue without historical if it fails)
    setPhase({ status: "running", stage: "gsc" })
    let gscHistorical: GSCTopQueryRow[] = []
    try {
      const sitesBody = await fetchJson<{ sites: GSCSiteInfo[] }>(
        "/api/gsc/sites",
        { method: "GET" },
        "GSC sites list",
      )
      const siteUrl = findBestGscSite(partner.website, sitesBody.sites ?? [])
      if (siteUrl) {
        const today = new Date()
        const start = new Date()
        start.setDate(today.getDate() - 90)
        const iso = (d: Date) => d.toISOString().slice(0, 10)
        const reportBody = await fetchJson<{ topQueries: GSCTopQueryRow[] }>(
          "/api/gsc/report-data",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              siteUrl,
              startDate: iso(start),
              endDate: iso(today),
              rowLimit: 200,
            }),
          },
          "GSC report data",
        )
        gscHistorical = reportBody.topQueries ?? []
      }
    } catch (err) {
      console.warn("[keyword-research] GSC fetch failed, continuing:", err)
    }

    // Stage 2: DFS ideas + suggestions (parallel)
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
                location,
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
                location,
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
            : "DataForSEO returned no keyword ideas. Try different seeds.",
        )
      }
    } catch (err) {
      setPhase({
        status: "error",
        message: err instanceof Error ? err.message : "DataForSEO request failed",
      })
      return
    }

    // Also include top GSC queries as candidate keywords (historical winners).
    const gscCandidates: KeywordResult[] = gscHistorical
      .slice(0, 50)
      .map((q) => ({ keyword: q.query }))

    const deduped = dedupeByKeyword([...dfsCombined, ...gscCandidates])

    // Stage 3: DFS bulk keyword difficulty
    setPhase({
      status: "running",
      stage: "dfs-difficulty",
      note: `${deduped.length} keywords`,
    })
    let enriched: KeywordResult[] = deduped
    try {
      // Bulk endpoint caps at 1000; safety-clamp anyway.
      const keywordList = deduped.map((r) => r.keyword).slice(0, 1000)
      const diffBody = await fetchJson<{ results: KeywordResult[] }>(
        "/api/dataforseo/keywords",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "difficulty",
            keywords: keywordList,
            location,
          }),
        },
        "DataForSEO difficulty",
      )
      const diffByKw = new Map(
        (diffBody.results ?? []).map((r) => [r.keyword.toLowerCase(), r]),
      )
      enriched = deduped.map((r) => {
        const d = diffByKw.get(r.keyword.toLowerCase())
        if (!d) return r
        return {
          ...r,
          keyword_difficulty: d.keyword_difficulty ?? r.keyword_difficulty,
          // bulk endpoint may also refresh volume/cpc when available
          search_volume: d.search_volume ?? r.search_volume,
          cpc: d.cpc ?? r.cpc,
          competition: d.competition ?? r.competition,
          competition_level: d.competition_level ?? r.competition_level,
        }
      })
    } catch (err) {
      // Difficulty is nice-to-have — continue without it, but warn.
      console.warn("[keyword-research] difficulty fetch failed:", err)
    }

    // Stage 4: Claude clustering + scoring
    setPhase({
      status: "running",
      stage: "claude",
      note: `${enriched.length} keywords`,
    })
    try {
      const body = await fetchJson<{
        clusters: KeywordCluster[]
        truncated?: number
      }>(
        "/api/claude/keywords",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            partner,
            rawKeywords: enriched,
            gscHistorical,
          }),
        },
        "Claude clustering",
      )
      const rows = (body.clusters ?? []).flatMap((c) => c.keywords)
      setPhase({
        status: "done",
        rows,
        clusters: body.clusters ?? [],
        truncated: body.truncated ?? 0,
      })
    } catch (err) {
      setPhase({
        status: "error",
        message:
          err instanceof Error ? err.message : "Claude clustering failed",
      })
    }
  }, [partner, effectiveSeeds, effectiveLocation])

  const rows = useMemo<ScoredKeyword[]>(
    () => (phase.status === "done" ? phase.rows : []),
    [phase],
  )
  const clusterNames = useMemo(() => {
    const names = new Set<string>()
    for (const r of rows) names.add(r.cluster)
    return Array.from(names).sort()
  }, [rows])

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (clusterFilter !== FILTER_ALL && r.cluster !== clusterFilter)
        return false
      if (recFilter !== FILTER_ALL && r.recommendation !== recFilter)
        return false
      return true
    })
  }, [rows, clusterFilter, recFilter])

  const sorted = useMemo(() => {
    const copy = filtered.slice()
    const { key, direction } = sort
    const sign = direction === "asc" ? 1 : -1
    copy.sort((a, b) => {
      const av = a[key]
      const bv = b[key]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === "number" && typeof bv === "number") {
        return sign * (av - bv)
      }
      return sign * String(av).localeCompare(String(bv))
    })
    return copy
  }, [filtered, sort])

  const toggleSort = useCallback((key: SortKey) => {
    setSort((prev) => {
      if (prev.key !== key) {
        const numeric =
          key === "search_volume" ||
          key === "keyword_difficulty" ||
          key === "fitScore"
        return { key, direction: numeric ? "desc" : "asc" }
      }
      return { key, direction: prev.direction === "asc" ? "desc" : "asc" }
    })
  }, [])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Keyword Research</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pull GSC history and DataForSEO keyword ideas, then have Claude cluster
          and score them for fit.
        </p>
      </div>

      {partnerLoading ? (
        <p className="text-sm text-muted-foreground">Loading partner…</p>
      ) : partnerError ? (
        <p className="text-sm text-destructive" role="alert">
          {partnerError}
        </p>
      ) : !partner ? (
        <p className="text-sm text-muted-foreground">
          Please select a partner from the dropdown above.
        </p>
      ) : (
        <>
          <PartnerSummary partner={partner} />

          <LocationSelector
            value={locationChoice}
            onChange={setLocationChoice}
            customValue={customLocation}
            onCustomChange={setCustomLocation}
            disabled={running}
          />

          <section className="space-y-3 rounded-lg border p-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="seeds">Seed keywords</Label>
              <Textarea
                id="seeds"
                placeholder={
                  defaultSeeds.length > 0
                    ? `Leave blank to auto-generate:\n${defaultSeeds.join("\n")}`
                    : "e.g. water heater repair, plumber near me"
                }
                value={seedsText}
                onChange={(e) => setSeedsText(e.target.value)}
                className="min-h-[100px]"
                disabled={running}
              />
              <p className="text-xs text-muted-foreground">
                Comma or newline separated. Capped at {MAX_SEEDS} seeds per run to
                keep DataForSEO costs in check.{" "}
                {effectiveSeeds.length > 0
                  ? `Using: ${effectiveSeeds.slice(0, MAX_SEEDS).join(", ")}`
                  : "No seeds yet."}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={handleRun}
                disabled={running || effectiveSeeds.length === 0}
              >
                {running ? "Running…" : "Run Research"}
              </Button>
              <StageProgress phase={phase} />
            </div>
          </section>

          <PhaseError phase={phase} />

          {phase.status === "done" ? (
            <section className="space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground">
                    Cluster
                  </span>
                  <Select value={clusterFilter} onValueChange={setClusterFilter}>
                    <SelectTrigger className="w-[220px]" aria-label="Filter by cluster">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={FILTER_ALL}>All clusters</SelectItem>
                      {clusterNames.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground">
                    Recommendation
                  </span>
                  <Select value={recFilter} onValueChange={setRecFilter}>
                    <SelectTrigger className="w-[180px]" aria-label="Filter by recommendation">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={FILTER_ALL}>All</SelectItem>
                      <SelectItem value="target">Target</SelectItem>
                      <SelectItem value="monitor">Monitor</SelectItem>
                      <SelectItem value="skip">Skip</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="ml-auto flex items-center gap-3">
                  <span className="text-xs text-muted-foreground">
                    {sorted.length} of {rows.length} keywords
                    {phase.truncated > 0
                      ? ` · ${phase.truncated} dropped by token budget`
                      : ""}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => downloadCsv(sorted, partner.name)}
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
                        onToggle={toggleSort}
                      >
                        Keyword
                      </SortableHead>
                      <SortableHead
                        sortKey="cluster"
                        sort={sort}
                        onToggle={toggleSort}
                      >
                        Cluster
                      </SortableHead>
                      <SortableHead
                        sortKey="search_volume"
                        sort={sort}
                        onToggle={toggleSort}
                        numeric
                      >
                        Volume
                      </SortableHead>
                      <SortableHead
                        sortKey="keyword_difficulty"
                        sort={sort}
                        onToggle={toggleSort}
                        numeric
                      >
                        Difficulty
                      </SortableHead>
                      <SortableHead
                        sortKey="fitScore"
                        sort={sort}
                        onToggle={toggleSort}
                        numeric
                      >
                        Fit
                      </SortableHead>
                      <SortableHead
                        sortKey="intent"
                        sort={sort}
                        onToggle={toggleSort}
                      >
                        Intent
                      </SortableHead>
                      <SortableHead
                        sortKey="recommendation"
                        sort={sort}
                        onToggle={toggleSort}
                      >
                        Recommendation
                      </SortableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sorted.length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={7}
                          className="text-center text-sm text-muted-foreground"
                        >
                          No keywords match the current filters.
                        </TableCell>
                      </TableRow>
                    ) : (
                      sorted.map((r) => (
                        <TableRow key={r.keyword}>
                          <TableCell className="font-medium">
                            {r.keyword}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {r.cluster}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {r.search_volume != null
                              ? r.search_volume.toLocaleString()
                              : "—"}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {r.keyword_difficulty != null
                              ? r.keyword_difficulty
                              : "—"}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            <FitBadge score={r.fitScore} />
                          </TableCell>
                          <TableCell>
                            <IntentLabel intent={r.intent} />
                          </TableCell>
                          <TableCell>
                            <RecommendationBadge value={r.recommendation} />
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </section>
          ) : null}
        </>
      )}
    </div>
  )
}

function PartnerSummary({ partner }: { partner: Partner }) {
  return (
    <section className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
      <div>
        <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Services
        </h2>
        <p className="mt-1 whitespace-pre-wrap text-sm">{partner.services}</p>
      </div>
      <div>
        <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Service areas
        </h2>
        <p className="mt-1 whitespace-pre-wrap text-sm">
          {partner.serviceAreas}
        </p>
      </div>
    </section>
  )
}

function LocationSelector({
  value,
  onChange,
  customValue,
  onCustomChange,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  customValue: string
  onCustomChange: (v: string) => void
  disabled?: boolean
}) {
  const isCustom = value === LOCATION_CUSTOM
  return (
    <section className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="dfs-location">DataForSEO location</Label>
        <Select value={value} onValueChange={onChange} disabled={disabled}>
          <SelectTrigger id="dfs-location" className="w-[360px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-[400px]">
            {US_DFS_LOCATIONS.map((loc) => (
              <SelectItem key={loc} value={loc}>
                {loc}
              </SelectItem>
            ))}
            <SelectItem value={LOCATION_CUSTOM}>Custom…</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Country- and state-level locations are always valid in DataForSEO.
          Use &ldquo;Custom…&rdquo; for a specific city in DFS&apos;s format:{" "}
          <code className="font-mono">City,State,United States</code> — note
          there are no spaces after the commas, and the state must be the full
          name (e.g.{" "}
          <code className="font-mono">Oklahoma City,Oklahoma,United States</code>
          ). DFS may still reject smaller cities.
        </p>
        {isCustom ? (
          <input
            type="text"
            value={customValue}
            onChange={(e) => onCustomChange(e.target.value)}
            placeholder="Oklahoma City,Oklahoma,United States"
            disabled={disabled}
            className="mt-1 w-[360px] rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-xs focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 outline-none disabled:cursor-not-allowed disabled:opacity-50"
          />
        ) : null}
      </div>
    </section>
  )
}

function StageProgress({ phase }: { phase: Phase }) {
  if (phase.status !== "running") return null
  const stages: Stage[] = ["gsc", "dfs-ideas", "dfs-difficulty", "claude"]
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

function FitBadge({ score }: { score: number }) {
  const variant =
    score >= 80 ? "default" : score >= 40 ? "secondary" : "outline"
  return <Badge variant={variant}>{score}</Badge>
}

function IntentLabel({ intent }: { intent: KeywordIntent }) {
  return (
    <span className="text-xs capitalize text-muted-foreground">{intent}</span>
  )
}

function RecommendationBadge({ value }: { value: KeywordRecommendation }) {
  if (value === "target") {
    return (
      <Badge
        variant="default"
        className="bg-emerald-600 text-white hover:bg-emerald-600/90"
      >
        Target
      </Badge>
    )
  }
  if (value === "monitor") {
    return <Badge variant="secondary">Monitor</Badge>
  }
  return (
    <Badge variant="outline" className="text-muted-foreground">
      Skip
    </Badge>
  )
}
