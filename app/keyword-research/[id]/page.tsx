"use client"

import { useEffect, useMemo, useState } from "react"
import { useParams, useRouter } from "next/navigation"
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CheckCircle2,
  DownloadIcon,
  Loader2,
  XCircle,
} from "lucide-react"
import { PageHeader } from "@/components/PageHeader"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
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
import { cn } from "@/lib/utils"

interface JobProgress {
  stage?: string
  detail?: string
  percent?: number | null
}

type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled"

interface KeywordRow {
  keyword: string
  search_volume?: number
  cpc?: number
  competition?: number
  competition_level?: "HIGH" | "MEDIUM" | "LOW"
  keyword_difficulty?: number
  intent?: "informational" | "navigational" | "commercial" | "transactional"
  currentRanking?: number
}

interface CityResult {
  location: {
    location_code: number
    location_name: string
    location_type: string
  }
  rows: KeywordRow[]
  rankProbeFailed: boolean
  unprobedKeywords: number
}

interface KeywordResearchResult {
  domain: string
  services: string[]
  competitors: string[]
  cities: CityResult[]
  shortlist: string[]
  shortlistRationale: string
  costUsd: number
  durationSeconds: number
  warnings: string[]
}

interface Job {
  id: string
  kind: string
  status: JobStatus
  title: string
  result: KeywordResearchResult | null
  progress: JobProgress
  error: string | null
  created_at: string
  completed_at: string | null
}

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

function shortLocationLabel(name: string): string {
  return name.split(",")[0]?.trim() || name
}

function csvEscape(value: unknown): string {
  if (value == null) return ""
  const s = String(value)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function buildCsv(rows: KeywordRow[]): string {
  const headers = ["Keyword", "Volume", "CPC", "Competition", "Current Ranking"]
  const lines = [headers.join(",")]
  for (const r of rows) {
    lines.push(
      [
        csvEscape(r.keyword),
        csvEscape(r.search_volume ?? ""),
        csvEscape(r.cpc ?? ""),
        csvEscape(r.competition_level ?? ""),
        csvEscape(r.currentRanking ?? ""),
      ].join(","),
    )
  }
  return lines.join("\n")
}

function downloadCsv(rows: KeywordRow[], domain: string, locationLabel: string) {
  const blob = new Blob([buildCsv(rows)], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  const slug = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  const stamp = new Date().toISOString().slice(0, 10)
  a.href = url
  a.download = `${slug(domain) || "domain"}-keywords-${slug(locationLabel) || "city"}-${stamp}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

const COMPETITION_RANK = { HIGH: 3, MEDIUM: 2, LOW: 1 } as const

function compareRow(a: KeywordRow, b: KeywordRow, sort: SortState): number {
  const dir = sort.direction === "asc" ? 1 : -1
  switch (sort.key) {
    case "keyword":
      return dir * a.keyword.localeCompare(b.keyword)
    case "search_volume":
      return dir * ((a.search_volume ?? 0) - (b.search_volume ?? 0))
    case "cpc":
      return dir * ((a.cpc ?? 0) - (b.cpc ?? 0))
    case "competition_level": {
      const av = a.competition_level ? COMPETITION_RANK[a.competition_level] : 0
      const bv = b.competition_level ? COMPETITION_RANK[b.competition_level] : 0
      return dir * (av - bv)
    }
    case "currentRanking": {
      const av = a.currentRanking ?? 9999
      const bv = b.currentRanking ?? 9999
      return dir * (av - bv)
    }
  }
}

export default function KeywordResearchResultPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const id = params?.id
  const [job, setJob] = useState<Job | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeCity, setActiveCity] = useState<string | null>(null)
  const [sort, setSort] = useState<SortState>({
    key: "search_volume",
    direction: "desc",
  })

  useEffect(() => {
    if (!id) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      try {
        const res = await fetch(`/api/jobs/${id}`, { cache: "no-store" })
        if (!res.ok) {
          setError(res.status === 404 ? "Job not found." : "Failed to load job.")
          return
        }
        const body = (await res.json()) as { job: Job }
        if (cancelled) return
        setJob(body.job)
        if (body.job.status === "queued" || body.job.status === "running") {
          timer = setTimeout(tick, 3000)
        }
      } catch {
        if (!cancelled) setError("Network error.")
      }
    }
    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [id])

  const result = job?.result ?? null

  // Default the active tab to the first city once results land.
  useEffect(() => {
    if (result && activeCity == null && result.cities.length > 0) {
      setActiveCity(String(result.cities[0].location.location_code))
    }
  }, [result, activeCity])

  const sortedByCity = useMemo(() => {
    if (!result) return new Map<string, KeywordRow[]>()
    const m = new Map<string, KeywordRow[]>()
    for (const c of result.cities) {
      const sorted = c.rows.slice().sort((a, b) => compareRow(a, b, sort))
      m.set(String(c.location.location_code), sorted)
    }
    return m
  }, [result, sort])

  const toggleSort = (key: SortKey) => {
    setSort((prev) => {
      if (prev.key !== key) {
        return { key, direction: key === "keyword" ? "asc" : "desc" }
      }
      return {
        key,
        direction: prev.direction === "asc" ? "desc" : "asc",
      }
    })
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Keyword Research</CardTitle>
          <CardDescription>{error}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={() => router.push("/keyword-research")}>
            Back to form
          </Button>
        </CardContent>
      </Card>
    )
  }

  if (!job) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading job…
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Research"
        title="Keyword Research"
        tail={`— ${job.title.replace(/^Keyword Research — /, "")}`}
        subtitle={
          <>
            Job ID: <span className="font-mono">{job.id}</span>
          </>
        }
      />

      {(job.status === "queued" || job.status === "running") && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Loader2 className="h-4 w-4 animate-spin" />
              {job.status === "queued" ? "Queued" : "Running"}
            </CardTitle>
            {job.progress.stage ? (
              <CardDescription>
                {job.progress.stage}
                {job.progress.detail ? ` — ${job.progress.detail}` : ""}
              </CardDescription>
            ) : null}
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">
              Phase 1 (national data) is fast. Phase 3 (city SERP probes) can
              take up to 10 minutes — feel free to close the tab; you'll get
              an email when it's done.
            </p>
          </CardContent>
        </Card>
      )}

      {job.status === "failed" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base text-destructive">
              <XCircle className="h-4 w-4" />
              Failed
            </CardTitle>
            <CardDescription>
              {job.error ?? "Unknown error. Check Vercel logs for the job id."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => router.push("/keyword-research")}>
              Back to form
            </Button>
          </CardContent>
        </Card>
      )}

      {job.status === "cancelled" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Cancelled</CardTitle>
            <CardDescription>This run was cancelled.</CardDescription>
          </CardHeader>
        </Card>
      )}

      {result && job.status === "completed" ? (
        <>
          <ResultMetadata result={result} />

          <Tabs
            value={
              activeCity ?? String(result.cities[0]?.location.location_code ?? "")
            }
            onValueChange={(v) => setActiveCity(v)}
          >
            <TabsList className="flex flex-wrap">
              {result.cities.map((c) => (
                <TabsTrigger
                  key={c.location.location_code}
                  value={String(c.location.location_code)}
                >
                  {shortLocationLabel(c.location.location_name)}
                  {c.rankProbeFailed ? (
                    <span className="ml-1 text-destructive">!</span>
                  ) : null}
                </TabsTrigger>
              ))}
            </TabsList>

            {result.cities.map((c) => {
              const rows =
                sortedByCity.get(String(c.location.location_code)) ?? c.rows
              return (
                <TabsContent
                  key={c.location.location_code}
                  value={String(c.location.location_code)}
                >
                  <CityPanel
                    city={c}
                    rows={rows}
                    domain={result.domain}
                    sort={sort}
                    onToggleSort={toggleSort}
                  />
                </TabsContent>
              )
            })}
          </Tabs>
        </>
      ) : null}
    </div>
  )
}

function ResultMetadata({ result }: { result: KeywordResearchResult }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2 text-base">
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            Run complete
          </CardTitle>
          <CardDescription>
            Probed {result.shortlist.length} keywords across{" "}
            {result.cities.length} {result.cities.length === 1 ? "city" : "cities"}.
            Discovered {result.competitors.length}{" "}
            {result.competitors.length === 1 ? "competitor" : "competitors"}.
          </CardDescription>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          <div>${result.costUsd.toFixed(2)} total</div>
          <div>{result.durationSeconds}s</div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {result.competitors.length > 0 ? (
          <div>
            <div className="font-medium text-foreground">Competitors</div>
            <div className="flex flex-wrap gap-1.5 pt-1">
              {result.competitors.map((c) => (
                <Badge key={c} variant="outline" className="font-mono text-xs">
                  {c}
                </Badge>
              ))}
            </div>
          </div>
        ) : null}
        {result.shortlistRationale ? (
          <div>
            <div className="font-medium text-foreground">
              Claude shortlist rationale
            </div>
            <p className="text-muted-foreground">{result.shortlistRationale}</p>
          </div>
        ) : null}
        {result.warnings.length > 0 ? (
          <div>
            <div className="font-medium text-foreground">Warnings</div>
            <ul className="ml-5 list-disc space-y-0.5 text-xs text-muted-foreground">
              {result.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

function CityPanel({
  city,
  rows,
  domain,
  sort,
  onToggleSort,
}: {
  city: CityResult
  rows: KeywordRow[]
  domain: string
  sort: SortState
  onToggleSort: (k: SortKey) => void
}) {
  return (
    <div className="space-y-3 pt-3">
      <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <span>
          Location:{" "}
          <span className="font-medium text-foreground">
            {city.location.location_name}
          </span>
        </span>
        <span>·</span>
        <span>
          Domain probed: <span className="font-mono text-foreground">{domain}</span>
        </span>
        {city.rankProbeFailed ? (
          <span className="ml-auto text-destructive">
            SERP probes failed for this city — Current Ranking column is empty.
          </span>
        ) : city.unprobedKeywords > 0 ? (
          <span className="ml-auto text-amber-600 dark:text-amber-500">
            {city.unprobedKeywords} keyword{city.unprobedKeywords === 1 ? "" : "s"}{" "}
            timed out before SERP returned. Showing partial results.
          </span>
        ) : null}
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {rows.length} keyword{rows.length === 1 ? "" : "s"}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            downloadCsv(rows, domain, shortLocationLabel(city.location.location_name))
          }
          disabled={rows.length === 0}
        >
          <DownloadIcon className="mr-2 size-4" />
          Export CSV
        </Button>
      </div>

      <div className="rounded-md border">
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
                Volume
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
            {rows.map((r) => (
              <TableRow key={r.keyword}>
                <TableCell className="font-mono text-sm">{r.keyword}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.search_volume != null
                    ? r.search_volume.toLocaleString()
                    : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.cpc != null ? `$${r.cpc.toFixed(2)}` : "—"}
                </TableCell>
                <TableCell>
                  {r.competition_level ? (
                    <Badge
                      variant="outline"
                      className={cn(
                        "font-mono text-xs",
                        r.competition_level === "HIGH" &&
                          "border-red-300 text-red-700 dark:border-red-500/40 dark:text-red-300",
                        r.competition_level === "MEDIUM" &&
                          "border-amber-300 text-amber-700 dark:border-amber-500/40 dark:text-amber-300",
                        r.competition_level === "LOW" &&
                          "border-green-300 text-green-700 dark:border-green-500/40 dark:text-green-300",
                      )}
                    >
                      {r.competition_level}
                    </Badge>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.currentRanking != null ? r.currentRanking : "—"}
                </TableCell>
              </TableRow>
            ))}
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground">
                  No keywords surfaced.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
    </div>
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
  const Icon = !active
    ? ArrowUpDown
    : sort.direction === "asc"
      ? ArrowUp
      : ArrowDown
  return (
    <TableHead className={cn(numeric && "text-right")}>
      <button
        type="button"
        onClick={() => onToggle(sortKey)}
        className={cn(
          "inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wider hover:text-foreground",
          active ? "text-foreground" : "text-muted-foreground",
          numeric && "ml-auto",
        )}
      >
        {children}
        <Icon className="h-3 w-3" />
      </button>
    </TableHead>
  )
}
