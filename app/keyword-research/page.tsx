"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { DownloadIcon, ArrowUpDown, ArrowDown, ArrowUp } from "lucide-react"
import { LocationAutocomplete } from "@/components/LocationAutocomplete"
import { PageHeader } from "@/components/PageHeader"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import { useChatPageContext } from "@/lib/chat-context"
import { useSelectedPartner } from "@/lib/use-selected-partner"
import { findSuggestedDfsLocation } from "@/lib/locations"
import { cn } from "@/lib/utils"
import type {
  DfsLabsLocation,
  KeywordCluster,
  KeywordIntent,
  KeywordRecommendation,
  KeywordResult,
  Partner,
  ScoredKeyword,
} from "@/lib/types"

type Stage =
  | "dfs-ideas"
  | "dfs-difficulty"
  | "dfs-volume"
  | "claude"
  | "dfs-serp-rank"
  | "done"

type LocationResult = {
  location: DfsLabsLocation
  rows: ScoredKeyword[]
  clusters: KeywordCluster[]
  truncated: number
  /** SERP probe failed for this location entirely; ranks are absent. */
  rankProbeFailed: boolean
}

type Phase =
  | { status: "idle" }
  | { status: "running"; stage: Stage; note?: string }
  | { status: "done"; results: LocationResult[]; domain: string }
  | { status: "error"; message: string }

type Mode = "partner" | "prospect"

type ProspectForm = {
  domain: string
  contextNotes: string
}

type SortKey =
  | "keyword"
  | "cluster"
  | "search_volume"
  | "keyword_difficulty"
  | "fitScore"
  | "intent"
  | "recommendation"
  | "currentRanking"

interface SortState {
  key: SortKey
  direction: "asc" | "desc"
}

const FILTER_ALL = "__all__"
// Safety ceiling on seeds per run. Each seed triggers two DataForSEO calls
// (ideas + suggestions), so this caps total DFS cost per run.
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
    case "dfs-ideas":
      return "Fetching keyword ideas & suggestions from DataForSEO…"
    case "dfs-difficulty":
      return "Measuring national keyword difficulty…"
    case "dfs-volume":
      return "Fetching city-level search volume per location…"
    case "claude":
      return "Clustering and scoring per location with Claude…"
    case "dfs-serp-rank":
      return "Probing live SERPs for current rankings per location…"
    case "done":
      return "Done."
  }
}

function stageIndex(stage: Stage): number {
  return [
    "dfs-ideas",
    "dfs-difficulty",
    "dfs-volume",
    "claude",
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

function buildCsv(rows: ScoredKeyword[]): string {
  const headers = [
    "Keyword",
    "Cluster",
    "Volume (city)",
    "Difficulty (national)",
    "Current Ranking",
    "Fit Score",
    "Intent",
    "Recommendation",
    "CPC",
    "Competition",
  ]
  const lines = [headers.join(",")]
  for (const r of rows) {
    const cols = [
      csvEscape(r.keyword),
      csvEscape(r.cluster),
      csvEscape(r.search_volume ?? ""),
      csvEscape(r.keyword_difficulty ?? ""),
      csvEscape(r.currentRanking ?? ""),
      csvEscape(r.fitScore),
      csvEscape(r.intent),
      csvEscape(r.recommendation),
      csvEscape(r.cpc ?? ""),
      csvEscape(r.competition_level ?? ""),
    ]
    lines.push(cols.join(","))
  }
  return lines.join("\n")
}

function downloadCsv(
  rows: ScoredKeyword[],
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

/**
 * The Claude scoring route requires a Partner-shaped object. In Prospect
 * mode we don't have one, so synthesize a minimal stand-in from the
 * domain + selected locations. Claude's relevance filtering will lean on
 * the seed keywords (which are user-supplied) and the candidate pool;
 * the Partner shape is just a structural fit for the existing route.
 */
function buildProspectPartner(
  domain: string,
  locations: DfsLabsLocation[],
  contextNotes: string,
): Partner {
  const trimmed = contextNotes.trim()
  return {
    id: `prospect-${domain}`,
    name: domain,
    services: trimmed || "(see seed keywords for service scope)",
    serviceAreas: locations.map((l) => l.location_name).join("\n"),
    website: `https://${domain}`,
  }
}

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
  const { partner, loading: partnerLoading, error: partnerError } =
    useSelectedPartner()
  const [mode, setMode] = useState<Mode>("partner")
  const [prospectForm, setProspectForm] = useState<ProspectForm>({
    domain: "",
    contextNotes: "",
  })
  const [seedsText, setSeedsText] = useState("")
  const [phase, setPhase] = useState<Phase>({ status: "idle" })
  const [activeLocationKey, setActiveLocationKey] = useState<string | null>(
    null,
  )
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
    // Reset run-scoped state when the partner changes. Mode/seeds/locations
    // are kept so the engineer can run the same query against a different
    // partner without re-typing.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPhase({ status: "idle" })
    setActiveLocationKey(null)
    setClusterFilter(FILTER_ALL)
    setRecFilter(FILTER_ALL)
  }, [partner?.id])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPhase({ status: "idle" })
    setActiveLocationKey(null)
    setClusterFilter(FILTER_ALL)
    setRecFilter(FILTER_ALL)
  }, [mode])

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

  const initialLocationQuery = useMemo(
    () =>
      mode === "partner" && partner
        ? findSuggestedDfsLocation(partner.serviceAreas)
        : "",
    [mode, partner],
  )

  const effectiveSeeds = useMemo(
    () => parseSeedsFromTextarea(seedsText),
    [seedsText],
  )

  const running = phase.status === "running"

  useChatPageContext("keyword-research", {
    tab: "Keyword Research",
    summary: [
      `Mode: ${mode}.`,
      mode === "partner"
        ? partner
          ? `Partner: ${partner.name} (${partner.website}).`
          : "No partner selected."
        : prospectForm.domain
          ? `Prospect domain: ${prospectForm.domain}.`
          : "No prospect domain entered.",
      effectiveSeeds.length > 0
        ? `${effectiveSeeds.length} seed keywords.`
        : "No seed keywords.",
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
      mode,
      seedCount: effectiveSeeds.length,
      seeds: effectiveSeeds.slice(0, 50),
      locations: selectedLocations.map((l) => ({
        code: l.location_code,
        name: l.location_name,
      })),
      phase: phase.status,
      results:
        phase.status === "done"
          ? phase.results.map((r) => ({
              location: r.location.location_name,
              keywordCount: r.rows.length,
              clusterCount: r.clusters.length,
              truncated: r.truncated,
              rankProbeFailed: r.rankProbeFailed,
              topKeywords: r.rows.slice(0, 15).map((k) => ({
                keyword: k.keyword,
                cluster: k.cluster,
                volume: k.search_volume,
                difficulty: k.keyword_difficulty,
                intent: k.intent,
                recommendation: k.recommendation,
                fitScore: k.fitScore,
              })),
            }))
          : null,
    },
  })

  /**
   * Resolve the run subject — either the selected Partner or the typed
   * Prospect. Returns null when the form is incomplete; the Run button
   * disables in that case. The `partnerForClaude` field is what we send
   * to /api/claude/keywords (which requires a Partner shape) — for
   * prospects this is a synthesized minimal Partner.
   */
  const subject = useMemo<
    | {
        kind: "partner"
        domain: string
        partnerForClaude: Partner
      }
    | {
        kind: "prospect"
        domain: string
        partnerForClaude: Partner
      }
    | null
  >(() => {
    if (mode === "partner") {
      if (!partner) return null
      const domain = normalizeDomainInput(partner.website)
      if (!domain) return null
      return { kind: "partner", domain, partnerForClaude: partner }
    }
    const domain = normalizeDomainInput(prospectForm.domain)
    if (!domain || !DOMAIN_REGEX.test(domain)) return null
    return {
      kind: "prospect",
      domain,
      partnerForClaude: buildProspectPartner(
        domain,
        selectedLocations,
        prospectForm.contextNotes,
      ),
    }
  }, [mode, partner, prospectForm, selectedLocations])

  const handleRun = useCallback(async () => {
    if (!subject) return
    const seeds = effectiveSeeds.slice(0, MAX_SEEDS)
    if (seeds.length === 0) {
      setPhase({
        status: "error",
        message:
          "Enter at least one seed keyword in the textarea before running research.",
      })
      return
    }
    if (selectedLocations.length === 0) {
      setPhase({
        status: "error",
        message:
          "Add at least one location from the search dropdown before running research.",
      })
      return
    }
    const parsedMax = parseInt(maxKeywordsInput, 10)
    const maxKeywords =
      Number.isFinite(parsedMax) && parsedMax > 0
        ? Math.min(parsedMax, MAX_KEYWORDS_CEILING)
        : DEFAULT_MAX_KEYWORDS

    // Country-shared stages: ideas/suggestions/difficulty are inherently
    // national in DataForSEO's Labs API. We use the first selected location's
    // country (always US for this tool's scope) by passing that locationCode
    // to the proxy, which collapses to US country code internally.
    const primaryLocationCode = selectedLocations[0].location_code

    // ── Stage 1: candidate pool ──────────────────────────────────────────
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
    const deduped = dedupeByKeyword(dfsCombined)

    // ── Stage 2: national difficulty ─────────────────────────────────────
    setPhase({
      status: "running",
      stage: "dfs-difficulty",
      note: `${deduped.length} keywords (US national)`,
    })
    let withDifficulty: KeywordResult[] = deduped
    try {
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
      withDifficulty = deduped.map((r) => {
        const d = diffByKw.get(r.keyword.toLowerCase())
        if (!d) return r
        return {
          ...r,
          keyword_difficulty: d.keyword_difficulty ?? r.keyword_difficulty,
        }
      })
    } catch (err) {
      console.warn("[keyword-research] difficulty fetch failed:", err)
    }

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
          // No city-level volume to fetch — just use the difficulty-enriched
          // pool with whatever country-level volume came back from Labs.
          enrichedByLoc.set(key, withDifficulty)
          return
        }
        try {
          const keywordList = withDifficulty
            .map((r) => r.keyword)
            .slice(0, 1000)
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
          const enriched = withDifficulty.map((r) => {
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
          enrichedByLoc.set(key, withDifficulty)
        }
      }),
    )

    // ── Stage 4: per-location Claude scoring (parallel) ──────────────────
    setPhase({
      status: "running",
      stage: "claude",
      note: `${selectedLocations.length} location${
        selectedLocations.length === 1 ? "" : "s"
      }`,
    })
    type ClaudeOut = {
      rows: ScoredKeyword[]
      clusters: KeywordCluster[]
      truncated: number
    }
    const claudeByLoc = new Map<string, ClaudeOut>()
    const claudeFailures: { location: string; message: string }[] = []
    await Promise.all(
      selectedLocations.map(async (loc) => {
        const key = locationKeyOf(loc)
        const enriched = enrichedByLoc.get(key) ?? withDifficulty
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
                partner: subject.partnerForClaude,
                rawKeywords: enriched,
                maxKeywords,
                allowedLocations: [loc.location_name],
              }),
            },
            `Claude clustering for ${loc.location_name}`,
          )
          const rows = (body.clusters ?? []).flatMap((c) => c.keywords)
          claudeByLoc.set(key, {
            rows,
            clusters: body.clusters ?? [],
            truncated: body.truncated ?? 0,
          })
        } catch (err) {
          claudeFailures.push({
            location: loc.location_name,
            message: err instanceof Error ? err.message : String(err),
          })
        }
      }),
    )
    if (claudeByLoc.size === 0) {
      setPhase({
        status: "error",
        message:
          claudeFailures.length > 0
            ? `Claude scoring failed for every location. First error (${claudeFailures[0].location}): ${claudeFailures[0].message}`
            : "Claude scoring returned no results.",
      })
      return
    }

    // ── Stage 5: per-location SERP rank probes (parallel) ────────────────
    setPhase({
      status: "running",
      stage: "dfs-serp-rank",
      note: `${claudeByLoc.size} location${claudeByLoc.size === 1 ? "" : "s"}`,
    })
    type RankRow = { keyword: string; position: number | null }
    type RankOut = { ranks: Map<string, number>; failed: boolean }
    const rankByLoc = new Map<string, RankOut>()
    await Promise.all(
      selectedLocations.map(async (loc) => {
        const key = locationKeyOf(loc)
        const claudeOut = claudeByLoc.get(key)
        if (!claudeOut || claudeOut.rows.length === 0) {
          rankByLoc.set(key, { ranks: new Map(), failed: false })
          return
        }
        const keywords = claudeOut.rows.map((r) => r.keyword)
        try {
          const body = await fetchJson<{ rows: RankRow[] }>(
            "/api/dataforseo/serp-rank",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                keywords,
                locationCode: loc.location_code,
                domain: subject.domain,
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
      const claudeOut = claudeByLoc.get(key)
      if (!claudeOut) continue
      const rankOut = rankByLoc.get(key) ?? { ranks: new Map(), failed: false }
      const decorate = <T extends ScoredKeyword>(r: T): T => ({
        ...r,
        currentRanking: rankOut.ranks.get(r.keyword.toLowerCase()),
      })
      const rows = claudeOut.rows.map(decorate)
      const clusters: KeywordCluster[] = claudeOut.clusters.map((c) => ({
        ...c,
        keywords: c.keywords.map(decorate),
      }))
      results.push({
        location: loc,
        rows,
        clusters,
        truncated: claudeOut.truncated,
        rankProbeFailed: rankOut.failed,
      })
    }

    setPhase({ status: "done", results, domain: subject.domain })
    setActiveLocationKey(locationKeyOf(selectedLocations[0]))
  }, [subject, effectiveSeeds, selectedLocations, maxKeywordsInput])

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

  const activeRows = useMemo<ScoredKeyword[]>(
    () => activeResult?.rows ?? [],
    [activeResult],
  )

  const clusterNames = useMemo(() => {
    const names = new Set<string>()
    for (const r of activeRows) names.add(r.cluster)
    return Array.from(names).sort()
  }, [activeRows])

  const filtered = useMemo(() => {
    return activeRows.filter((r) => {
      if (clusterFilter !== FILTER_ALL && r.cluster !== clusterFilter)
        return false
      if (recFilter !== FILTER_ALL && r.recommendation !== recFilter)
        return false
      return true
    })
  }, [activeRows, clusterFilter, recFilter])

  const sorted = useMemo(() => {
    const copy = filtered.slice()
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
  }, [filtered, sort])

  const toggleSort = useCallback((key: SortKey) => {
    setSort((prev) => {
      if (prev.key !== key) {
        // currentRanking defaults to ascending (best rank first); other
        // numeric columns default to descending (highest first).
        const defaultAsc = key === "currentRanking"
        const defaultDesc =
          !defaultAsc &&
          (key === "search_volume" ||
            key === "keyword_difficulty" ||
            key === "fitScore")
        return { key, direction: defaultDesc ? "desc" : "asc" }
      }
      return { key, direction: prev.direction === "asc" ? "desc" : "asc" }
    })
  }, [])

  const csvSlugSource =
    mode === "partner" && partner ? partner.name : subject?.domain ?? "subject"

  const subjectReady = subject != null
  const partnerModeBlocked =
    mode === "partner" &&
    !partnerLoading &&
    !partnerError &&
    !partner

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Tool / Keyword Research"
        title="Keyword Research"
        tail="— score the long list."
        subtitle={
          <>
            Pull{" "}
            <b className="font-sans font-extrabold not-italic text-foreground">
              DataForSEO
            </b>{" "}
            keyword ideas, then have{" "}
            <b className="font-sans font-extrabold not-italic text-foreground">
              Claude
            </b>{" "}
            cluster and score them per location, with live SERP rank
            probes against the target domain.
          </>
        }
      />

      <ModeToggle mode={mode} onChange={setMode} disabled={running} />

      {mode === "partner" ? (
        partnerLoading ? (
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
          <PartnerSummary partner={partner} />
        )
      ) : (
        <ProspectFormSection
          form={prospectForm}
          onChange={setProspectForm}
          disabled={running}
        />
      )}

      {!partnerModeBlocked ? (
        <>
          <section className="space-y-3 rounded-lg border p-4">
            <LocationAutocomplete
              initialQuery={initialLocationQuery}
              selected={selectedLocations}
              onAdd={addLocation}
              onRemove={removeLocation}
              disabled={running}
              label="DataForSEO locations — one results tab per location"
              helpText={
                selectedLocations.length === 0 ? (
                  <>
                    Start typing to find cities, counties, or states in
                    DataForSEO&apos;s Google Ads taxonomy. Each location you
                    add gets its own results tab with location-specific
                    search volume, current SERP rank for the target domain,
                    and a Claude scoring pass scoped to that market.
                  </>
                ) : (
                  <>
                    {selectedLocations.length} location
                    {selectedLocations.length === 1 ? "" : "s"} selected.
                    Each becomes its own tab in the results.
                  </>
                )
              }
            />
          </section>

          <section className="space-y-3 rounded-lg border p-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="seeds">Seed keywords</Label>
              <Textarea
                id="seeds"
                placeholder="e.g. water heater repair, plumber near me, emergency drain service"
                value={seedsText}
                onChange={(e) => setSeedsText(e.target.value)}
                className="min-h-[100px]"
                disabled={running}
              />
              <p className="text-xs text-muted-foreground">
                Comma or newline separated. At least one is required. Each
                seed costs two DataForSEO calls, so the first {MAX_SEEDS} are
                used per run.{" "}
                {effectiveSeeds.length > 0
                  ? `Using (${Math.min(effectiveSeeds.length, MAX_SEEDS)}): ${effectiveSeeds.slice(0, MAX_SEEDS).join(", ")}`
                  : null}
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
                How many keywords Claude surfaces per location. Each surfaced
                keyword also gets a live SERP rank probe per location, so
                this knob is the main cost lever. Default{" "}
                {DEFAULT_MAX_KEYWORDS}, hard-capped at {MAX_KEYWORDS_CEILING}.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={handleRun}
                disabled={
                  running ||
                  !subjectReady ||
                  effectiveSeeds.length === 0 ||
                  selectedLocations.length === 0
                }
              >
                {running ? "Running…" : "Run Research"}
              </Button>
              <StageProgress phase={phase} />
            </div>
          </section>

          <PhaseError phase={phase} />

          {phase.status === "done" && results.length > 0 ? (
            <section className="space-y-3">
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
                          clusterNames={clusterNames}
                          clusterFilter={clusterFilter}
                          recFilter={recFilter}
                          onClusterFilter={setClusterFilter}
                          onRecFilter={setRecFilter}
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
        </>
      ) : null}
    </div>
  )
}

function ModeToggle({
  mode,
  onChange,
  disabled,
}: {
  mode: Mode
  onChange: (m: Mode) => void
  disabled?: boolean
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border">
      {(["partner", "prospect"] as const).map((value) => {
        const active = mode === value
        const label = value === "partner" ? "Partner" : "Prospect"
        return (
          <button
            key={value}
            type="button"
            onClick={() => onChange(value)}
            disabled={disabled}
            aria-pressed={active}
            className={cn(
              "px-4 py-1.5 text-sm font-medium transition-colors",
              active
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground",
              disabled && "cursor-not-allowed opacity-50",
            )}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}

function ProspectFormSection({
  form,
  onChange,
  disabled,
}: {
  form: ProspectForm
  onChange: (next: ProspectForm) => void
  disabled?: boolean
}) {
  return (
    <section className="space-y-4 rounded-lg border p-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="prospect-domain">
          Prospect domain <span className="text-destructive">*</span>
        </Label>
        <Input
          id="prospect-domain"
          type="text"
          placeholder="example.com"
          value={form.domain}
          onChange={(e) => onChange({ ...form, domain: e.target.value })}
          disabled={disabled}
        />
        <p className="text-xs text-muted-foreground">
          Bare hostname or full URL — used as the target for live SERP rank
          probes per location. No GSC / GA4 access required.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="prospect-context">Services / context (optional)</Label>
        <Textarea
          id="prospect-context"
          placeholder="e.g. Residential plumbing — water heaters, drain cleaning, emergency repair."
          value={form.contextNotes}
          onChange={(e) => onChange({ ...form, contextNotes: e.target.value })}
          disabled={disabled}
          className="min-h-[80px]"
        />
        <p className="text-xs text-muted-foreground">
          Helps Claude scope keyword relevance. If left blank, Claude relies
          entirely on the seed keywords below.
        </p>
      </div>
    </section>
  )
}

function LocationResultPanel({
  result,
  domain,
  sorted,
  totalRows,
  clusterNames,
  clusterFilter,
  recFilter,
  onClusterFilter,
  onRecFilter,
  sort,
  onToggleSort,
  onExport,
}: {
  result: LocationResult
  domain: string
  sorted: ScoredKeyword[]
  totalRows: number
  clusterNames: string[]
  clusterFilter: string
  recFilter: string
  onClusterFilter: (v: string) => void
  onRecFilter: (v: string) => void
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
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">
            Cluster
          </span>
          <Select value={clusterFilter} onValueChange={onClusterFilter}>
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
          <Select value={recFilter} onValueChange={onRecFilter}>
            <SelectTrigger
              className="w-[180px]"
              aria-label="Filter by recommendation"
            >
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
            {sorted.length} of {totalRows} keywords
            {result.truncated > 0
              ? ` · ${result.truncated} dropped by token budget`
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
                sortKey="cluster"
                sort={sort}
                onToggle={onToggleSort}
              >
                Cluster
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
                sortKey="keyword_difficulty"
                sort={sort}
                onToggle={onToggleSort}
                numeric
              >
                Difficulty (national)
              </SortableHead>
              <SortableHead
                sortKey="currentRanking"
                sort={sort}
                onToggle={onToggleSort}
                numeric
              >
                Current Ranking
              </SortableHead>
              <SortableHead
                sortKey="fitScore"
                sort={sort}
                onToggle={onToggleSort}
                numeric
              >
                Fit
              </SortableHead>
              <SortableHead
                sortKey="intent"
                sort={sort}
                onToggle={onToggleSort}
              >
                Intent
              </SortableHead>
              <SortableHead
                sortKey="recommendation"
                sort={sort}
                onToggle={onToggleSort}
              >
                Recommendation
              </SortableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className="text-center text-sm text-muted-foreground"
                >
                  No keywords match the current filters.
                </TableCell>
              </TableRow>
            ) : (
              sorted.map((r) => (
                <TableRow key={r.keyword}>
                  <TableCell className="font-medium">{r.keyword}</TableCell>
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
                    <CurrentRankingCell value={r.currentRanking} />
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

/**
 * Collapsible panel above the results table describing where each column's
 * value actually comes from. Helps the SEO engineer answer "why is this
 * keyword here?" without having to re-read the code.
 */
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
            A candidate keyword. The candidate pool is shared across location
            tabs because DataForSEO&apos;s{" "}
            <code className="font-mono">keyword_ideas</code> /{" "}
            <code className="font-mono">keyword_suggestions</code> endpoints
            are country-level only. Locations differentiate downstream on
            volume, current rank, and Claude&apos;s scoring.
          </dd>
        </div>
        <div>
          <dt className="font-medium text-foreground">Cluster</dt>
          <dd className="text-muted-foreground">
            Topical grouping assigned by Claude (per location). Short 2–4
            word label (e.g. &ldquo;Emergency Repair&rdquo;, &ldquo;Pricing
            &amp; Estimates&rdquo;).
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
          <dt className="font-medium text-foreground">Difficulty (national)</dt>
          <dd className="text-muted-foreground">
            Keyword difficulty (0–100) from DataForSEO&apos;s{" "}
            <code className="font-mono">bulk_keyword_difficulty</code>{" "}
            endpoint. This is country-level only — DataForSEO&apos;s Labs
            API doesn&apos;t expose city-level difficulty — so the same
            value is shown in every location tab.
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
        <div>
          <dt className="font-medium text-foreground">Fit</dt>
          <dd className="text-muted-foreground">
            Claude&apos;s 0–100 fit score for this location. Combines (1)
            topical + geographic relevance, (2) realistic difficulty for a
            local service business, (3) meaningful volume, (4) intent.
          </dd>
        </div>
        <div>
          <dt className="font-medium text-foreground">Intent</dt>
          <dd className="text-muted-foreground">
            <strong>Informational</strong>, <strong>Commercial</strong>,{" "}
            <strong>Transactional</strong>, or <strong>Navigational</strong>.
          </dd>
        </div>
        <div>
          <dt className="font-medium text-foreground">Recommendation</dt>
          <dd className="text-muted-foreground">
            <strong>Target</strong> = pursue now.{" "}
            <strong>Monitor</strong> = track but not priority.{" "}
            <strong>Skip</strong> = de-prioritize.
          </dd>
        </div>
      </dl>
    </details>
  )
}

function StageProgress({ phase }: { phase: Phase }) {
  if (phase.status !== "running") return null
  const stages: Stage[] = [
    "dfs-ideas",
    "dfs-difficulty",
    "dfs-volume",
    "claude",
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
  // Top 3 = green, top 10 = blue, top 30 = neutral, beyond = muted.
  const variant: "default" | "secondary" | "outline" =
    value <= 10 ? "default" : value <= 30 ? "secondary" : "outline"
  return <Badge variant={variant}>{value}</Badge>
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
