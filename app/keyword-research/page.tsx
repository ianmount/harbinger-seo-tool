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
} from "@/lib/locations"
import { cn } from "@/lib/utils"
import type {
  DfsLabsLocation,
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
  | "dfs-local-volume"
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
// Safety ceiling on seeds per run. Each seed triggers two DataForSEO calls
// (ideas + suggestions), so this caps total DFS cost per run. The default
// seed generator surfaces *every* partner service (no hidden truncation);
// this only kicks in for pathologically long Airtable Services fields.
const MAX_SEEDS = 50
const DEFAULT_MAX_KEYWORDS = 300
// Keep in sync with MAX_OUTPUT_KEYWORDS in /api/claude/keywords/route.ts.
// Past this the compact-tuple output risks truncating against Claude's
// max_tokens ceiling.
const MAX_KEYWORDS_CEILING = 500

function parseSeedsFromTextarea(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * Strip markdown/list noise from a service string so it can be used as a
 * DataForSEO seed. Airtable service fields are free-text and often contain
 * bold markers, list bullets, trailing colons, and embedded links.
 */
function cleanServiceName(raw: string): string {
  return raw
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // [text](url) → text
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1") // **bold** / *italic* → text
    .replace(/^[\s\-*•–—]+/, "") // leading bullet/dash
    .replace(/[:;]\s*$/, "") // trailing punctuation
    .replace(/[()]/g, "") // stray parens
    .replace(/\s+/g, " ") // collapse whitespace
    .trim()
}

/**
 * Extract a clean city name from a DFS location row's display name
 * (e.g. "Oklahoma City,Oklahoma,United States" → "Oklahoma City").
 * Returns null for country/state-level selections where there's no city.
 */
function cityFromLocation(loc: DfsLabsLocation | null): string | null {
  if (!loc) return null
  if (loc.location_type === "Country" || loc.location_type === "State") {
    return null
  }
  const first = loc.location_name.split(",")[0]?.trim()
  return first && first.length > 0 ? first : null
}

// Words that commonly appear as a section header in the Services field
// (e.g. "**Services:**", "Our Offerings:") and survive markdown stripping.
// Treat them as noise so we don't ship seeds like "Services in Oklahoma City".
const SERVICE_HEADER_NOISE = new Set([
  "service",
  "services",
  "offering",
  "offerings",
  "product",
  "products",
  "solution",
  "solutions",
  "our services",
  "our offerings",
  "our products",
  "our solutions",
  "what we do",
  "what we offer",
  "main services",
  "key services",
  "core services",
  "primary services",
])

function generateDefaultSeeds(
  partner: Partner,
  selectedLocation: DfsLabsLocation | null,
): string[] {
  // Every cleaned service name becomes a seed. No hidden truncation — if
  // the partner lists 15 services we generate 15 seeds (×2 variants when
  // we have a city); the MAX_SEEDS ceiling in the parent run-handler is
  // the only backstop against runaway Airtable fields.
  const services = partner.services
    .split(/[\n,;]/)
    .map(cleanServiceName)
    .filter((s) => {
      // Sanity-check a "service name": short-ish, not a URL, not a sentence,
      // and not a generic section header that slipped through markdown cleanup.
      if (s.length < 2 || s.length > 60) return false
      if (/^https?:\/\//i.test(s)) return false
      if (s.split(/\s+/).length > 8) return false
      if (SERVICE_HEADER_NOISE.has(s.toLowerCase())) return false
      return true
    })

  // Prefer the explicitly picked location's city. Falling back to parsing
  // partner.serviceAreas is risky — that field often contains addresses,
  // URL-wrapped markdown, and stray labels that yield bogus "cities"
  // (e.g. "Physical Locations" from "Physical location: <address>").
  const city =
    cityFromLocation(selectedLocation) ??
    parseLocationCities(partner.serviceAreas)[0] ??
    null

  const seeds: string[] = []
  for (const service of services) {
    if (city) {
      seeds.push(`${service} in ${city}`)
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
    case "dfs-local-volume":
      return "Fetching city-level search volume…"
    case "claude":
      return "Clustering and scoring with Claude…"
    case "done":
      return "Done."
  }
}

function stageIndex(stage: Stage): number {
  return [
    "gsc",
    "dfs-ideas",
    "dfs-difficulty",
    "dfs-local-volume",
    "claude",
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
  const [selectedLocations, setSelectedLocations] = useState<
    DfsLabsLocation[]
  >([])
  const [maxKeywordsInput, setMaxKeywordsInput] = useState<string>(
    String(DEFAULT_MAX_KEYWORDS),
  )

  useEffect(() => {
    // Reset state when partner changes. The URL param drives partner selection,
    // so this is a sync from external state into component state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPhase({ status: "idle" })
    setClusterFilter(FILTER_ALL)
    setRecFilter(FILTER_ALL)
    setSeedsText("")
    setSelectedLocations([])
    setMaxKeywordsInput(String(DEFAULT_MAX_KEYWORDS))
  }, [partner?.id])

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

  // First selected location drives city-based seed generation. The full
  // list is used to aggregate volume and to scope Claude's selection.
  const primaryLocation = selectedLocations[0] ?? null

  const defaultSeeds = useMemo(
    () => (partner ? generateDefaultSeeds(partner, primaryLocation) : []),
    [partner, primaryLocation],
  )

  const initialLocationQuery = useMemo(
    () => (partner ? findSuggestedDfsLocation(partner.serviceAreas) : ""),
    [partner],
  )

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
    const parsedMax = parseInt(maxKeywordsInput, 10)
    const maxKeywords =
      Number.isFinite(parsedMax) && parsedMax > 0
        ? Math.min(parsedMax, MAX_KEYWORDS_CEILING)
        : DEFAULT_MAX_KEYWORDS
    if (selectedLocations.length === 0) {
      setPhase({
        status: "error",
        message:
          "Add at least one location from the search dropdown before running research.",
      })
      return
    }

    // Labs-level calls (ideas/suggestions/difficulty) run at US country level
    // regardless; Google Ads search_volume fans out across all selected
    // locations and volumes are summed per keyword downstream.
    const locationLabels = selectedLocations.map((l) => l.location_name)
    const primaryLocationCode = selectedLocations[0].location_code

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
            locationCode: primaryLocationCode,
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

    // Stage 4: Local volume enrichment. Labs' keyword_ideas/suggestions only
    // give country-level volume; we overlay city-level volume from Google
    // Ads search_volume so the user actually sees local demand. When the
    // user picked multiple locations, we fan out in parallel and sum the
    // per-keyword volumes — that's the total addressable demand across the
    // partner's service footprint. CPC/competition come from the first
    // location that has a value.
    const cityLevelLocations = selectedLocations.filter(
      (l) => l.location_type !== "Country",
    )
    if (cityLevelLocations.length > 0) {
      setPhase({
        status: "running",
        stage: "dfs-local-volume",
        note: `${enriched.length} keywords × ${cityLevelLocations.length} location${
          cityLevelLocations.length === 1 ? "" : "s"
        }`,
      })
      try {
        const keywordList = enriched.map((r) => r.keyword).slice(0, 1000)
        const volResponses = await Promise.all(
          cityLevelLocations.map((loc) =>
            fetchJson<{ results: KeywordResult[] }>(
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
              `DataForSEO local search volume for ${loc.location_name}`,
            ),
          ),
        )

        type LocalAgg = {
          volumeSum: number
          hasVolume: boolean
          cpc?: number
          competition?: number
          competition_level?: KeywordResult["competition_level"]
        }
        const aggByKw = new Map<string, LocalAgg>()
        for (const resp of volResponses) {
          for (const r of resp.results ?? []) {
            const key = r.keyword.trim().toLowerCase()
            if (!key) continue
            const agg = aggByKw.get(key) ?? {
              volumeSum: 0,
              hasVolume: false,
            }
            if (r.search_volume != null) {
              agg.volumeSum += r.search_volume
              agg.hasVolume = true
            }
            if (agg.cpc == null && r.cpc != null) agg.cpc = r.cpc
            if (agg.competition == null && r.competition != null)
              agg.competition = r.competition
            if (!agg.competition_level && r.competition_level)
              agg.competition_level = r.competition_level
            aggByKw.set(key, agg)
          }
        }

        enriched = enriched.map((r) => {
          const agg = aggByKw.get(r.keyword.toLowerCase())
          if (!agg) return r
          return {
            ...r,
            search_volume: agg.hasVolume ? agg.volumeSum : r.search_volume,
            cpc: agg.cpc ?? r.cpc,
            competition: agg.competition ?? r.competition,
            competition_level: agg.competition_level ?? r.competition_level,
          }
        })
      } catch (err) {
        console.warn(
          "[keyword-research] local volume fetch failed, using country-level:",
          err,
        )
      }
    }

    // Stage 5: Claude clustering + scoring
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
            maxKeywords,
            allowedLocations: locationLabels,
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
  }, [partner, effectiveSeeds, selectedLocations, maxKeywordsInput])

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

          <LocationAutocomplete
            initialQuery={initialLocationQuery}
            selected={selectedLocations}
            onAdd={addLocation}
            onRemove={removeLocation}
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
                Comma or newline separated. Defaults include every partner
                service (from Airtable) × two location variants (<code>in
                &lt;city&gt;</code> and <code>near me</code>). Safety cap at{" "}
                {MAX_SEEDS} seeds per run — each seed costs two DataForSEO
                calls. {" "}
                {effectiveSeeds.length > 0
                  ? `Using (${Math.min(effectiveSeeds.length, MAX_SEEDS)}): ${effectiveSeeds.slice(0, MAX_SEEDS).join(", ")}`
                  : "No seeds yet."}
              </p>
            </div>

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
                How many keywords Claude will surface in the results table.
                Claude sees the full candidate pool from DataForSEO and picks
                the best ones by relevance, volume, difficulty, and intent —
                it may return fewer if the pool runs out of good fits.
                Default {DEFAULT_MAX_KEYWORDS}, hard-capped at{" "}
                {MAX_KEYWORDS_CEILING}.
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

function LocationAutocomplete({
  initialQuery,
  selected,
  onAdd,
  onRemove,
  disabled,
}: {
  initialQuery: string
  selected: DfsLabsLocation[]
  onAdd: (loc: DfsLabsLocation) => void
  onRemove: (code: number) => void
  disabled?: boolean
}) {
  const [query, setQuery] = useState(initialQuery)
  const [results, setResults] = useState<DfsLabsLocation[]>([])
  const [fetching, setFetching] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)

  const selectedCodes = useMemo(
    () => new Set(selected.map((l) => l.location_code)),
    [selected],
  )

  // When the partner changes we want the initial query to re-seed the input.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setQuery(initialQuery)
  }, [initialQuery])

  // Debounced fetch against /api/dataforseo/locations?q=<query>
  useEffect(() => {
    const abort = new AbortController()
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFetching(true)
    setFetchError(null)

    const timer = setTimeout(async () => {
      try {
        const url = new URL(
          "/api/dataforseo/locations",
          window.location.origin,
        )
        if (query.trim()) url.searchParams.set("q", query.trim())
        const response = await fetch(url.toString(), { signal: abort.signal })
        const body = (await response.json().catch(() => ({}))) as {
          results?: DfsLabsLocation[]
          error?: string
        }
        if (!response.ok) {
          throw new Error(body.error ?? `HTTP ${response.status}`)
        }
        if (!cancelled) {
          setResults(body.results ?? [])
          setActiveIndex(0)
        }
      } catch (err) {
        if (cancelled || (err instanceof Error && err.name === "AbortError")) {
          return
        }
        setFetchError(
          err instanceof Error ? err.message : "Failed to load locations",
        )
      } finally {
        if (!cancelled) setFetching(false)
      }
    }, 250)

    return () => {
      cancelled = true
      abort.abort()
      clearTimeout(timer)
    }
  }, [query])

  const handleSelect = (loc: DfsLabsLocation) => {
    if (selectedCodes.has(loc.location_code)) {
      // Already added — just close and clear the query for the next add.
      setQuery("")
      setOpen(false)
      return
    }
    onAdd(loc)
    // Clear query so the user can immediately search for the next location.
    setQuery("")
    setOpen(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || results.length === 0) {
      if (e.key === "ArrowDown") {
        setOpen(true)
      }
      return
    }
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActiveIndex((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActiveIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      const pick = results[activeIndex]
      if (pick) handleSelect(pick)
    } else if (e.key === "Escape") {
      setOpen(false)
    }
  }

  return (
    <section className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="dfs-location-search">
          DataForSEO locations — add every city / state the partner serves
        </Label>
        <div className="relative w-[420px]">
          <input
            id="dfs-location-search"
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setOpen(true)
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => {
              // Delay so click handlers on list items still fire.
              setTimeout(() => setOpen(false), 150)
            }}
            onKeyDown={handleKeyDown}
            placeholder="Search: city, state, zip, or country…"
            disabled={disabled}
            autoComplete="off"
            role="combobox"
            aria-expanded={open}
            aria-controls="dfs-location-listbox"
            aria-activedescendant={
              open && results[activeIndex]
                ? `dfs-location-opt-${results[activeIndex].location_code}`
                : undefined
            }
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
          />
          {open ? (
            <ul
              id="dfs-location-listbox"
              role="listbox"
              className="absolute z-50 mt-1 max-h-[320px] w-full overflow-auto rounded-md border bg-popover p-1 text-sm shadow-md"
            >
              {fetching && results.length === 0 ? (
                <li className="px-2 py-1.5 text-muted-foreground">
                  Searching…
                </li>
              ) : null}
              {fetchError ? (
                <li className="px-2 py-1.5 text-destructive">{fetchError}</li>
              ) : null}
              {!fetching && !fetchError && results.length === 0 ? (
                <li className="px-2 py-1.5 text-muted-foreground">
                  No matches. Try a broader search.
                </li>
              ) : null}
              {results.map((loc, i) => {
                const alreadyAdded = selectedCodes.has(loc.location_code)
                return (
                  <li
                    key={loc.location_code}
                    id={`dfs-location-opt-${loc.location_code}`}
                    role="option"
                    aria-selected={i === activeIndex}
                    aria-disabled={alreadyAdded}
                    onMouseDown={(e) => {
                      // onMouseDown fires before onBlur, so we can select
                      // before the list closes.
                      e.preventDefault()
                      if (!alreadyAdded) handleSelect(loc)
                    }}
                    onMouseEnter={() => setActiveIndex(i)}
                    className={cn(
                      "flex items-center justify-between gap-2 rounded-sm px-2 py-1.5",
                      alreadyAdded
                        ? "cursor-not-allowed opacity-50"
                        : "cursor-pointer",
                      i === activeIndex && !alreadyAdded
                        ? "bg-accent text-accent-foreground"
                        : "",
                    )}
                  >
                    <span className="truncate">{loc.location_name}</span>
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {alreadyAdded ? "added" : loc.location_type}
                    </span>
                  </li>
                )
              })}
            </ul>
          ) : null}
        </div>

        {selected.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5">
            {selected.map((loc) => (
              <li
                key={loc.location_code}
                className="inline-flex items-center gap-1 rounded-full border bg-secondary px-2 py-0.5 text-xs"
              >
                <span className="font-mono">{loc.location_name}</span>
                <span className="text-[9px] uppercase tracking-wide text-muted-foreground">
                  {loc.location_type}
                </span>
                <button
                  type="button"
                  onClick={() => onRemove(loc.location_code)}
                  disabled={disabled}
                  aria-label={`Remove ${loc.location_name}`}
                  className="ml-0.5 rounded-full px-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <p className="text-xs text-muted-foreground">
          {selected.length === 0 ? (
            <>
              Start typing to find cities, counties, or states in DataForSEO&apos;s
              Google Ads taxonomy. Add every area the partner serves — local
              volume will be summed across them and Claude will drop keywords
              that reference cities outside this list.
            </>
          ) : (
            <>
              {selected.length} location{selected.length === 1 ? "" : "s"}{" "}
              selected. Search + add more if the partner&apos;s service area
              covers additional cities.
            </>
          )}
        </p>
      </div>
    </section>
  )
}

function StageProgress({ phase }: { phase: Phase }) {
  if (phase.status !== "running") return null
  const stages: Stage[] = [
    "gsc",
    "dfs-ideas",
    "dfs-difficulty",
    "dfs-local-volume",
    "claude",
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
