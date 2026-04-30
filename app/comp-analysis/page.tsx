"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Download, Loader2, Sparkles, Upload, X } from "lucide-react"
import { toast } from "sonner"
import { JobsForKindCard } from "@/components/JobsForKindCard"
import { ensureNotificationPermission } from "@/components/JobsTray"
import { LocationAutocomplete } from "@/components/LocationAutocomplete"
import { PageHeader } from "@/components/PageHeader"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useAssessment } from "@/lib/assessment-context"
import { useChatPageContext } from "@/lib/chat-context"
import { parseTargetLocationLines } from "@/lib/locations"
import type {
  CompAnalysisDomainRow,
  CompAnalysisLocationRows,
  DfsLabsLocation,
} from "@/lib/types"

/**
 * Competitive Analysis tab — SERP-based methodology.
 *
 * For each (seed keyword × city × domain) we query DataForSEO's SERP
 * endpoint at depth=100 and aggregate Top 3/10/20/100 buckets per
 * (domain × city) from the resulting rank_absolute values. Numbers
 * genuinely vary by city because the underlying SERPs do.
 */

const SERP_COST_USD = 0.002

interface RunResponse {
  rows: CompAnalysisLocationRows[]
  csv: string
  warnings: string[]
  seedCount: number
  estimatedSerpCost: number
}

interface SuggestResponse {
  suggestions: { domain: string; frequency: number }[]
}

/**
 * Parse the first column of a CSV. Handles simple quoting; skips a
 * header row when the first cell looks like a column name.
 */
function parseCsvFirstColumn(text: string): string[] {
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    let firstCol: string
    if (line.startsWith('"')) {
      const endQuote = line.indexOf('"', 1)
      firstCol = endQuote > 0 ? line.slice(1, endQuote) : line.slice(1)
    } else {
      const commaIdx = line.indexOf(",")
      firstCol = commaIdx >= 0 ? line.slice(0, commaIdx) : line
    }
    firstCol = firstCol.trim()
    if (i === 0 && /^(keyword|search ?term|query|seed)s?$/i.test(firstCol)) {
      continue
    }
    if (firstCol) out.push(firstCol)
  }
  return Array.from(new Set(out.map((s) => s.toLowerCase())))
}

function dedupeKeywords(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of text.split("\n")) {
    const k = line.trim()
    if (!k) continue
    const lc = k.toLowerCase()
    if (seen.has(lc)) continue
    seen.add(lc)
    out.push(k)
  }
  return out
}

export default function CompAnalysisPage() {
  const { state, setField, setMany } = useAssessment()
  const [running, setRunning] = useState(false)
  // Auto-suggest is per-location now; track which location-code is
  // currently fetching so we can disable just that block's button.
  const [suggestingForCode, setSuggestingForCode] = useState<number | null>(
    null,
  )
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [partnerUrl, setPartnerUrl] = useState(state.websiteUrl)
  // Per-location competitor textarea text, keyed by location_code.
  // Initialized from context's locationCompetitors so navigating away
  // and back preserves the user's typing.
  const [competitorTextByCode, setCompetitorTextByCode] = useState<
    Record<number, string>
  >(() => {
    const init: Record<number, string> = {}
    for (const lc of state.locationCompetitors) {
      init[lc.locationCode] = lc.competitors.join("\n")
    }
    return init
  })
  const [csvKeywords, setCsvKeywords] = useState<string[]>([])
  const [csvFilename, setCsvFilename] = useState<string | null>(null)
  const [manualText, setManualText] = useState("")
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // CSV always wins when present; clearing it falls back to whatever the
  // textarea has. Mutual exclusion is enforced when the user starts typing.
  const seedKeywords = useMemo(() => {
    if (csvKeywords.length > 0) return csvKeywords
    return dedupeKeywords(manualText)
  }, [csvKeywords, manualText])

  const initialLocationQuery = useMemo(() => {
    if (state.compDfsLocations.length > 0) return ""
    const parsed = parseTargetLocationLines(state.targetLocations)
    if (parsed.length === 0) return ""
    return parsed[0].city
  }, [state.compDfsLocations.length, state.targetLocations])

  /** Parse a competitor textarea into a clean, deduped domain list. */
  const parseCompetitorText = useCallback((text: string): string[] => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const line of text.split("\n")) {
      const cleaned = line
        .trim()
        .replace(/^https?:\/\//i, "")
        .replace(/^www\./i, "")
        .replace(/\/.*$/, "")
        .toLowerCase()
      if (!cleaned || seen.has(cleaned)) continue
      seen.add(cleaned)
      out.push(cleaned)
    }
    return out
  }, [])

  /** Per-location parsed competitor lists, in compDfsLocations order. */
  const competitorsByCode = useMemo(() => {
    const map = new Map<number, string[]>()
    for (const loc of state.compDfsLocations) {
      const text = competitorTextByCode[loc.location_code] ?? ""
      map.set(loc.location_code, parseCompetitorText(text))
    }
    return map
  }, [state.compDfsLocations, competitorTextByCode, parseCompetitorText])

  const cityCount = state.compDfsLocations.length
  const seedCount = seedKeywords.length
  const estimatedCost = seedCount * cityCount * SERP_COST_USD

  // Run is enabled only when every location has ≥1 competitor.
  const everyLocationHasCompetitor =
    cityCount > 0 &&
    state.compDfsLocations.every(
      (loc) => (competitorsByCode.get(loc.location_code)?.length ?? 0) > 0,
    )

  const canRun =
    !running &&
    partnerUrl.trim().length > 0 &&
    cityCount > 0 &&
    everyLocationHasCompetitor &&
    seedCount > 0

  // Comp Analysis form/result state already flows into the chat via the
  // AssessmentContext auto-pull in AppShell. This hook adds the
  // page-local UI state (loading, current per-location competitor edits,
  // CSV/manual seed source) so the chat can answer "why can't I run yet"
  // and "what competitors did I list for Sarasota".
  useChatPageContext("comp-analysis", {
    tab: "Comp Analysis",
    summary: [
      `Partner URL: ${partnerUrl || "(empty)"}.`,
      `${cityCount} location(s) selected, ${seedCount} seed keyword(s).`,
      everyLocationHasCompetitor
        ? "All locations have competitors."
        : "At least one location is missing competitors.",
      running ? "Run in progress." : canRun ? "Ready to run." : "Run blocked.",
      errorMessage ? `Last error: ${errorMessage}.` : "",
    ]
      .filter(Boolean)
      .join(" "),
    data: {
      partnerUrl,
      seedSource: csvKeywords.length > 0 ? "csv" : "manual",
      seedCount,
      seedSampleKeywords: seedKeywords.slice(0, 30),
      locations: state.compDfsLocations.map((loc) => ({
        code: loc.location_code,
        name: loc.location_name,
        competitors: competitorsByCode.get(loc.location_code) ?? [],
      })),
      running,
      canRun,
      estimatedCostUsd: estimatedCost,
    },
  })

  const handleFile = useCallback(async (file: File) => {
    try {
      const text = await file.text()
      const parsed = parseCsvFirstColumn(text)
      if (parsed.length === 0) {
        toast.error("No keywords found in CSV. Check that the first column has keywords.")
        return
      }
      setCsvKeywords(parsed)
      setCsvFilename(file.name)
      setManualText("")
      toast.success(`${parsed.length} keyword${parsed.length === 1 ? "" : "s"} loaded from CSV`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error"
      toast.error("Failed to read CSV", { description: msg })
    }
  }, [])

  const clearCsv = useCallback(() => {
    setCsvKeywords([])
    setCsvFilename(null)
    if (fileInputRef.current) fileInputRef.current.value = ""
  }, [])

  const handleManualChange = useCallback(
    (value: string) => {
      setManualText(value)
      // First keystroke after a CSV upload clears the CSV — mutual exclusion.
      if (value.trim().length > 0 && csvKeywords.length > 0) {
        setCsvKeywords([])
        setCsvFilename(null)
        if (fileInputRef.current) fileInputRef.current.value = ""
      }
    },
    [csvKeywords.length],
  )

  const addLocation = useCallback(
    (loc: DfsLabsLocation) => {
      const next = state.compDfsLocations.some(
        (l) => l.location_code === loc.location_code,
      )
        ? state.compDfsLocations
        : [...state.compDfsLocations, loc]
      setField("compDfsLocations", next)
    },
    [state.compDfsLocations, setField],
  )

  const removeLocation = useCallback(
    (code: number) => {
      setField(
        "compDfsLocations",
        state.compDfsLocations.filter((l) => l.location_code !== code),
      )
    },
    [state.compDfsLocations, setField],
  )

  /**
   * Auto-suggest competitors for a single location. Seed keywords still
   * come from this tab's keyword inputs, but the SERP probes use only
   * the targeted location's code so suggestions reflect that city's
   * actual top-ranking domains.
   */
  const autoSuggestForLocation = useCallback(
    async (loc: DfsLabsLocation) => {
      if (!partnerUrl.trim()) {
        toast.error("Enter a partner URL first.")
        return
      }
      if (seedKeywords.length === 0) {
        setErrorMessage(
          "Auto-suggest needs seed keywords. Upload a CSV or paste keywords first.",
        )
        return
      }
      setSuggestingForCode(loc.location_code)
      setErrorMessage(null)
      try {
        const res = await fetch("/api/comp-analysis/suggest-competitors", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            partnerUrl: partnerUrl.trim(),
            seedKeywords: seedKeywords.slice(0, 10),
            targetLocations: [loc],
          }),
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error ?? `HTTP ${res.status}`)
        }
        const data = (await res.json()) as SuggestResponse
        const suggested = data.suggestions.map((s) => s.domain)
        const existing = competitorsByCode.get(loc.location_code) ?? []
        const merged = Array.from(
          new Set([
            ...existing,
            ...suggested.filter((d) => !existing.includes(d)),
          ]),
        )
        setCompetitorTextByCode((prev) => ({
          ...prev,
          [loc.location_code]: merged.join("\n"),
        }))
        if (suggested.length === 0) {
          toast.info(
            `No competitors found for ${loc.location_name}. Try different seed keywords.`,
          )
        } else {
          toast.success(
            `Added ${suggested.length} suggestion${suggested.length === 1 ? "" : "s"} for ${loc.location_name}.`,
          )
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error"
        setErrorMessage(message)
        toast.error("Auto-suggest failed", { description: message })
      } finally {
        setSuggestingForCode(null)
      }
    },
    [partnerUrl, seedKeywords, competitorsByCode],
  )

  // Active job id while a comp analysis is in flight. Polled below; on
  // completion, hydrates back into AssessmentContext so the existing
  // result tables render unchanged.
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const [jobProgress, setJobProgress] = useState<string | null>(null)

  useEffect(() => {
    if (!activeJobId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      try {
        const res = await fetch(`/api/jobs/${activeJobId}`, {
          cache: "no-store",
        })
        if (cancelled) return
        if (!res.ok) {
          if (res.status === 404) {
            setRunning(false)
            setActiveJobId(null)
          }
          return
        }
        const body = (await res.json()) as {
          job: {
            status: string
            progress: { stage?: string; detail?: string }
            result: RunResponse | null
            error: string | null
          }
        }
        const j = body.job
        const detail = j.progress?.detail
          ? `${j.progress.stage} — ${j.progress.detail}`
          : j.progress?.stage ?? null
        setJobProgress(detail)
        if (j.status === "completed" && j.result) {
          setMany({
            compAnalysisRows: j.result.rows,
            compAnalysisCsv: j.result.csv,
            compAnalysisRunAt: new Date().toISOString(),
            compAnalysisWarnings: j.result.warnings,
          })
          if (j.result.warnings.length > 0) {
            toast.warning("Comp analysis complete with warnings", {
              description: j.result.warnings[0],
            })
          } else {
            toast.success("Comp analysis ready")
          }
          setRunning(false)
          setActiveJobId(null)
          setJobProgress(null)
        } else if (j.status === "failed") {
          setErrorMessage(j.error ?? "Comp analysis failed")
          toast.error("Comp analysis failed", {
            description: j.error ?? undefined,
          })
          setRunning(false)
          setActiveJobId(null)
          setJobProgress(null)
        } else if (j.status === "cancelled") {
          toast.message("Comp analysis cancelled")
          setRunning(false)
          setActiveJobId(null)
          setJobProgress(null)
        } else {
          timer = setTimeout(tick, 3000)
        }
      } catch {
        if (cancelled) return
        timer = setTimeout(tick, 5000)
      }
    }
    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [activeJobId, setMany])

  const runAnalysis = useCallback(async () => {
    if (!canRun) return
    setRunning(true)
    setErrorMessage(null)
    void ensureNotificationPermission()

    const locationCompetitors = state.compDfsLocations.map((loc) => ({
      location: loc.location_name,
      locationCode: loc.location_code,
      competitors: competitorsByCode.get(loc.location_code) ?? [],
    }))

    setMany({
      websiteUrl: partnerUrl.trim(),
      locationCompetitors,
    })
    try {
      const res = await fetch("/api/jobs/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "comp_analysis",
          title: `Comp Analysis — ${partnerUrl.trim()}`,
          input: {
            partnerUrl: partnerUrl.trim(),
            locationCompetitors,
            seedKeywords,
          },
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const { jobId } = (await res.json()) as { jobId: string }
      setActiveJobId(jobId)
      toast.message("Comp analysis started", {
        description: "Running in the background — feel free to leave the tab.",
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error"
      setErrorMessage(message)
      toast.error("Could not start comp analysis", { description: message })
      setRunning(false)
    }
  }, [
    canRun,
    partnerUrl,
    state.compDfsLocations,
    competitorsByCode,
    seedKeywords,
    setMany,
  ])

  const downloadCsv = useCallback(() => {
    if (!state.compAnalysisCsv) return
    const filename = `comp-analysis-${partnerUrl
      .trim()
      .replace(/[^a-zA-Z0-9.-]/g, "_")}-${new Date().toISOString().slice(0, 10)}.csv`
    const blob = new Blob([state.compAnalysisCsv], {
      type: "text/csv;charset=utf-8",
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, [state.compAnalysisCsv, partnerUrl])

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Assessments / Competitive Analysis"
        title="Competitive Analysis"
        tail="— SERP rank coverage by city"
        subtitle={
          <>
            For each seed keyword × city we query Google&apos;s SERP and
            count how many of your{" "}
            <b className="font-sans font-extrabold not-italic text-foreground">
              approved target keywords
            </b>{" "}
            each domain ranks for at top 3 / 10 / 20 / 100 in that specific
            city. Numbers vary by city because the SERPs do.
          </>
        }
      />

      <section className="space-y-5 rounded-lg border bg-card p-5">
        <div className="space-y-1.5">
          <Label htmlFor="partnerUrl">Partner URL</Label>
          <Input
            id="partnerUrl"
            placeholder="https://examplelandscaping.com"
            value={partnerUrl}
            onChange={(e) => setPartnerUrl(e.target.value)}
            disabled={running}
          />
        </div>

        <div className="space-y-2">
          <LocationAutocomplete
            initialQuery={initialLocationQuery}
            selected={state.compDfsLocations}
            onAdd={addLocation}
            onRemove={removeLocation}
            disabled={running}
            label="Target locations (search DataForSEO's taxonomy)"
            inputId="comp-location-search"
            helpText={
              state.compDfsLocations.length === 0 ? (
                <>
                  Type a city, state, or zip — pick the location DataForSEO
                  has indexed. The SERP probes use these codes directly.
                </>
              ) : (
                <>
                  {state.compDfsLocations.length} location
                  {state.compDfsLocations.length === 1 ? "" : "s"} selected.
                </>
              )
            }
          />
        </div>

        <SeedKeywordsInput
          csvKeywords={csvKeywords}
          csvFilename={csvFilename}
          manualText={manualText}
          onFile={handleFile}
          onClearCsv={clearCsv}
          onManualChange={handleManualChange}
          fileInputRef={fileInputRef}
          disabled={running}
          parsedCount={seedKeywords.length}
        />

        {state.compDfsLocations.length === 0 ? (
          <p className="rounded-md border border-dashed p-3 text-sm text-ink-3">
            Add at least one target location above to configure
            competitors.
          </p>
        ) : (
          <div className="space-y-4">
            <Label>Competitors per location</Label>
            <p className="-mt-2 text-xs text-ink-3">
              Each location gets its own competitor list — a domain that
              matters in Sarasota doesn&apos;t have to appear in
              Bradenton. Run is enabled when every location has at least
              one competitor.
            </p>
            {state.compDfsLocations.map((loc) => {
              const text = competitorTextByCode[loc.location_code] ?? ""
              const parsed = competitorsByCode.get(loc.location_code) ?? []
              const isSuggesting =
                suggestingForCode === loc.location_code
              return (
                <div
                  key={loc.location_code}
                  className="space-y-2 rounded-lg border bg-background p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-sans text-[11px] font-extrabold uppercase tracking-[0.18em] text-ink-2">
                      {loc.location_name}
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => autoSuggestForLocation(loc)}
                      disabled={
                        running ||
                        suggestingForCode != null ||
                        !partnerUrl.trim() ||
                        seedKeywords.length === 0
                      }
                    >
                      {isSuggesting ? (
                        <>
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />{" "}
                          Suggesting…
                        </>
                      ) : (
                        <>
                          <Sparkles className="mr-1.5 h-3.5 w-3.5" />{" "}
                          Auto-suggest
                        </>
                      )}
                    </Button>
                  </div>
                  <Textarea
                    placeholder={"competitor1.com\ncompetitor2.com"}
                    value={text}
                    onChange={(e) =>
                      setCompetitorTextByCode((prev) => ({
                        ...prev,
                        [loc.location_code]: e.target.value,
                      }))
                    }
                    disabled={running}
                    rows={4}
                  />
                  <p className="text-xs text-ink-3">
                    {parsed.length} competitor
                    {parsed.length === 1 ? "" : "s"}
                    {parsed.length === 0
                      ? " · add at least one to enable Run"
                      : ""}
                    {seedKeywords.length === 0
                      ? " · auto-suggest needs seed keywords"
                      : ""}
                  </p>
                </div>
              )
            })}
          </div>
        )}

        {errorMessage && (
          <p className="text-sm text-destructive" role="alert">
            {errorMessage}
          </p>
        )}

        <div className="flex flex-col items-stretch gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-ink-3">
            {seedCount > 0 && cityCount > 0 ? (
              <>
                This will run ~
                <b className="font-sans font-extrabold not-italic text-foreground">
                  {seedCount * cityCount}
                </b>{" "}
                SERP queries (~
                <b className="font-sans font-extrabold not-italic text-foreground">
                  ${estimatedCost.toFixed(2)}
                </b>
                ).
              </>
            ) : (
              "Add seed keywords + at least one location to enable Run."
            )}
          </p>
          <Button type="button" onClick={runAnalysis} disabled={!canRun}>
            {running ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Running
                analysis…
              </>
            ) : (
              "Run Analysis"
            )}
          </Button>
        </div>

        {running && jobProgress && (
          <p className="text-xs text-ink-3" aria-live="polite">
            {jobProgress}
          </p>
        )}
      </section>

      {state.compAnalysisRows && state.compAnalysisRows.length > 0 && (
        <CompResults
          rows={state.compAnalysisRows}
          warnings={state.compAnalysisWarnings}
          seedCount={seedKeywords.length || state.compAnalysisRows[0]?.domains[0]?.top100 ? seedKeywords.length : 0}
          onDownload={downloadCsv}
        />
      )}

      <JobsForKindCard kind="comp_analysis" title="Recent comp analysis runs" />
    </div>
  )
}

function SeedKeywordsInput({
  csvKeywords,
  csvFilename,
  manualText,
  onFile,
  onClearCsv,
  onManualChange,
  fileInputRef,
  disabled,
  parsedCount,
}: {
  csvKeywords: string[]
  csvFilename: string | null
  manualText: string
  onFile: (file: File) => void
  onClearCsv: () => void
  onManualChange: (value: string) => void
  fileInputRef: React.MutableRefObject<HTMLInputElement | null>
  disabled: boolean
  parsedCount: number
}) {
  const csvLoaded = csvKeywords.length > 0
  return (
    <div className="space-y-2">
      <Label>Seed keywords</Label>

      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          id="seed-csv-upload"
          disabled={disabled}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) onFile(file)
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          asChild
          disabled={disabled}
        >
          <label htmlFor="seed-csv-upload" className="cursor-pointer">
            <Upload className="mr-1.5 h-3.5 w-3.5" /> Upload CSV
          </label>
        </Button>
        {csvLoaded ? (
          <span className="inline-flex items-center gap-1 rounded-full border bg-secondary px-2 py-0.5 text-xs">
            <span className="font-mono">{csvFilename}</span>
            <button
              type="button"
              onClick={onClearCsv}
              disabled={disabled}
              aria-label="Clear CSV"
              className="ml-0.5 rounded-full px-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ) : (
          <span className="text-xs text-ink-3">or paste below</span>
        )}
      </div>

      {!csvLoaded && (
        <Textarea
          id="manualKeywords"
          placeholder={"kitchen remodel\nbathroom remodeling near me\ncustom cabinetry"}
          value={manualText}
          onChange={(e) => onManualChange(e.target.value)}
          disabled={disabled}
          rows={6}
        />
      )}

      <p className="text-xs text-ink-3">
        {parsedCount > 0
          ? `${parsedCount} keyword${parsedCount === 1 ? "" : "s"} ${
              csvLoaded ? "loaded from CSV" : "parsed"
            } · duplicates removed`
          : csvLoaded
            ? "CSV had no usable keywords in the first column"
            : "One keyword per line. CSV upload reads the first column."}
      </p>
    </div>
  )
}

function CompResults({
  rows,
  warnings,
  seedCount,
  onDownload,
}: {
  rows: CompAnalysisLocationRows[]
  warnings: string[]
  seedCount: number
  onDownload: () => void
}) {
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between rounded-lg border bg-card p-4">
        <div>
          <h2 className="text-lg font-semibold">Results</h2>
          <p className="text-sm text-ink-3">
            {rows.length} location{rows.length === 1 ? "" : "s"} ·{" "}
            {rows[0]?.domains.length ?? 0} domain
            {(rows[0]?.domains.length ?? 0) === 1 ? "" : "s"} per location
          </p>
        </div>
        <Button type="button" onClick={onDownload}>
          <Download className="mr-2 h-4 w-4" /> Download CSV
        </Button>
      </div>

      <div className="rounded-md border border-line-strong/40 bg-brand-paper/40 p-3 text-xs text-ink-2">
        <strong className="font-sans font-extrabold uppercase tracking-[0.16em] text-[10px] text-ink-3">
          Methodology
        </strong>
        <p className="mt-1">
          Top 3/10/20/100 reflects how many of your
          {seedCount > 0 ? ` ${seedCount} ` : " "}
          approved target keywords each domain ranks for in the specified
          city. Numbers vary by city because rankings are measured against
          city-level Google SERPs.
        </p>
      </div>

      {warnings.length > 0 && (
        <details
          open
          className="rounded-md border border-amber-400/50 bg-amber-50 text-xs text-amber-900 dark:bg-amber-900/20 dark:text-amber-200"
        >
          <summary className="cursor-pointer px-3 py-2 font-semibold">
            {Array.from(new Set(warnings)).length} warning
            {Array.from(new Set(warnings)).length === 1 ? "" : "s"}
          </summary>
          <ul className="list-inside list-disc px-3 pb-3 pt-1 font-mono text-[11px]">
            {Array.from(new Set(warnings)).map((w, i) => (
              <li key={i} className="break-all">
                {w}
              </li>
            ))}
          </ul>
        </details>
      )}

      <p className="text-xs text-ink-3">
        Note: &ldquo;Pages Indexed&rdquo; uses Google&apos;s <code>site:</code>{" "}
        operator at the city level and is approximate. &ldquo;Organic
        Traffic&rdquo; is country-wide (Labs domain_rank_overview accepts
        country codes only).
      </p>

      <div className="space-y-6">
        {rows.map((loc) => (
          <LocationTable key={loc.locationCode} location={loc} />
        ))}
      </div>
    </section>
  )
}

function LocationTable({ location }: { location: CompAnalysisLocationRows }) {
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="flex items-center gap-2 border-b bg-muted/30 px-4 py-2 font-sans text-[11px] font-extrabold uppercase tracking-[0.18em] text-ink-2">
        <span>{location.location}</span>
        <span className="rounded bg-secondary px-1.5 py-0.5 text-[9px] font-bold tracking-[0.16em] text-ink-3">
          {location.locationType}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-ink-3">
              <th className="px-3 py-2 font-medium">Website</th>
              <th className="px-3 py-2 text-right font-medium">Top 3</th>
              <th className="px-3 py-2 text-right font-medium">Top 10</th>
              <th className="px-3 py-2 text-right font-medium">Top 20</th>
              <th className="px-3 py-2 text-right font-medium">Top 100</th>
              <th className="px-3 py-2 text-right font-medium">Ref. Domains</th>
              <th className="px-3 py-2 text-right font-medium">Pages Indexed</th>
              <th className="px-3 py-2 text-right font-medium">
                Organic Traffic
              </th>
            </tr>
          </thead>
          <tbody>
            {location.domains.map((d) => (
              <DomainRow key={d.domain} row={d} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function DomainRow({ row }: { row: CompAnalysisDomainRow }) {
  return (
    <tr
      className={
        "border-b last:border-b-0 " +
        (row.isPartner ? "bg-brand-paper/40 font-semibold" : "")
      }
    >
      <td className="px-3 py-2">
        {row.domain}
        {row.isPartner ? (
          <span className="ml-2 rounded bg-brand-red/10 px-1.5 py-0.5 font-sans text-[9px] font-extrabold uppercase tracking-[0.16em] text-brand-red">
            partner
          </span>
        ) : null}
        {row.failed ? (
          <span className="ml-2 text-xs text-amber-600">⚠ partial</span>
        ) : null}
      </td>
      <td className="px-3 py-2 text-right">{row.top3.toLocaleString()}</td>
      <td className="px-3 py-2 text-right">{row.top10.toLocaleString()}</td>
      <td className="px-3 py-2 text-right">{row.top20.toLocaleString()}</td>
      <td className="px-3 py-2 text-right">{row.top100.toLocaleString()}</td>
      <td className="px-3 py-2 text-right">
        {row.referringDomains.toLocaleString()}
      </td>
      <td className="px-3 py-2 text-right">
        {row.pagesIndexed.toLocaleString()}
      </td>
      <td className="px-3 py-2 text-right">{row.organicTraffic}</td>
    </tr>
  )
}
