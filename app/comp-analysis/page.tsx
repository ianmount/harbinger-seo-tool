"use client"

import { useCallback, useMemo, useState } from "react"
import { Download, Loader2, Sparkles } from "lucide-react"
import { toast } from "sonner"
import { PageHeader } from "@/components/PageHeader"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useAssessment } from "@/lib/assessment-context"
import { parseTargetLocationLines } from "@/lib/locations"
import type {
  CompAnalysisDomainRow,
  CompAnalysisLocationRows,
} from "@/lib/types"

/**
 * Competitive Analysis tab.
 *
 * Stateless. Inputs are pre-filled from the shared Assessment context if
 * the Audit tab was already run; otherwise the user fills them manually.
 * Output is an on-screen table grouped by location plus a CSV export.
 */

interface RunResponse {
  rows: CompAnalysisLocationRows[]
  csv: string
  warnings: string[]
}

interface SuggestResponse {
  suggestions: { domain: string; frequency: number }[]
}

export default function CompAnalysisPage() {
  const { state, setField, setMany } = useAssessment()
  const [running, setRunning] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  // Keep a local copy of the textarea so multi-line edits aren't fighting
  // the array shape. Initialize from context once (Audit tab populates
  // websiteUrl + targetLocations).
  const [partnerUrl, setPartnerUrl] = useState(state.websiteUrl)
  const [targetLocationsText, setTargetLocationsText] = useState(
    state.targetLocations,
  )
  const [competitorText, setCompetitorText] = useState(
    state.competitorUrls.join("\n"),
  )

  const targetLocations = useMemo(
    () => parseTargetLocationLines(targetLocationsText),
    [targetLocationsText],
  )
  const competitors = useMemo(
    () =>
      competitorText
        .split("\n")
        .map((s) =>
          s
            .trim()
            .replace(/^https?:\/\//i, "")
            .replace(/^www\./i, "")
            .replace(/\/.*$/, "")
            .toLowerCase(),
        )
        .filter((s) => s.length > 0),
    [competitorText],
  )

  const canRun =
    !running &&
    partnerUrl.trim().length > 0 &&
    targetLocations.length > 0 &&
    competitors.length > 0

  const seedKeywordsFromContext = useMemo(() => {
    const fromGsc = state.auditResult?.gscData?.topQueries
      ?.slice()
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 10)
      .map((q) => q.query)
    if (fromGsc && fromGsc.length > 0) return fromGsc
    return state.existingTargetKeywords
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  }, [state.auditResult, state.existingTargetKeywords])

  const autoSuggest = useCallback(async () => {
    if (!partnerUrl.trim()) {
      toast.error("Enter a partner URL first.")
      return
    }
    if (targetLocations.length === 0) {
      toast.error("Enter at least one target location.")
      return
    }
    if (seedKeywordsFromContext.length === 0) {
      setErrorMessage(
        "No seed keywords available. Run the Audit first or paste competitor URLs manually.",
      )
      return
    }
    setSuggesting(true)
    setErrorMessage(null)
    try {
      const res = await fetch("/api/comp-analysis/suggest-competitors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          partnerUrl: partnerUrl.trim(),
          seedKeywords: seedKeywordsFromContext,
          targetLocations,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const data = (await res.json()) as SuggestResponse
      const suggested = data.suggestions.map((s) => s.domain)
      const merged = Array.from(
        new Set([
          ...competitors,
          ...suggested.filter((d) => !competitors.includes(d)),
        ]),
      )
      setCompetitorText(merged.join("\n"))
      setField("competitorUrls", merged)
      if (suggested.length === 0) {
        toast.info("No competitors found. Try different seed keywords.")
      } else {
        toast.success(`Added ${suggested.length} suggested competitor${suggested.length === 1 ? "" : "s"}.`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error"
      setErrorMessage(message)
      toast.error("Auto-suggest failed", { description: message })
    } finally {
      setSuggesting(false)
    }
  }, [
    partnerUrl,
    targetLocations,
    seedKeywordsFromContext,
    competitors,
    setField,
  ])

  const runAnalysis = useCallback(async () => {
    if (!canRun) return
    setRunning(true)
    setErrorMessage(null)
    // Sync textareas back into shared state so subsequent runs / tab
    // navigation see the latest values.
    setMany({
      websiteUrl: partnerUrl.trim(),
      targetLocations: targetLocationsText,
      competitorUrls: competitors,
    })
    try {
      const res = await fetch("/api/comp-analysis/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          partnerUrl: partnerUrl.trim(),
          targetLocations,
          competitorUrls: competitors,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const data = (await res.json()) as RunResponse
      setMany({
        compAnalysisRows: data.rows,
        compAnalysisCsv: data.csv,
        compAnalysisRunAt: new Date().toISOString(),
        compAnalysisWarnings: data.warnings,
      })
      if (data.warnings.length > 0) {
        toast.warning("Comp analysis complete with warnings", {
          description: data.warnings[0],
        })
      } else {
        toast.success("Comp analysis ready")
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error"
      setErrorMessage(message)
      toast.error("Comp analysis failed", { description: message })
    } finally {
      setRunning(false)
    }
  }, [
    canRun,
    partnerUrl,
    targetLocationsText,
    targetLocations,
    competitors,
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
        tail="— DataForSEO ranking comparison"
        subtitle={
          <>
            Compare a prospect&apos;s organic visibility against named
            competitors across target locations. Counts are{" "}
            <b className="font-sans font-extrabold not-italic text-foreground">
              total domain rankings
            </b>{" "}
            in DataForSEO&apos;s database — not filtered to industry keywords.
            Pre-fills inputs from the Audit tab if it was run first.
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

        <div className="space-y-1.5">
          <Label htmlFor="targetLocations">
            Target locations (one per line — &ldquo;City, State&rdquo;)
          </Label>
          <Textarea
            id="targetLocations"
            placeholder={"Sarasota, FL\nBradenton, FL"}
            value={targetLocationsText}
            onChange={(e) => setTargetLocationsText(e.target.value)}
            disabled={running}
            rows={3}
          />
          <p className="text-xs text-ink-3">
            Parsed {targetLocations.length} location
            {targetLocations.length === 1 ? "" : "s"}. The analysis tries
            city-level data first; if DataForSEO doesn&apos;t support a
            given city it falls back to state level for that row (flagged
            in the results table).
          </p>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="competitorUrls">
              Competitor URLs (one per line)
            </Label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={autoSuggest}
              disabled={
                running ||
                suggesting ||
                !partnerUrl.trim() ||
                targetLocations.length === 0
              }
            >
              {suggesting ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />{" "}
                  Suggesting…
                </>
              ) : (
                <>
                  <Sparkles className="mr-1.5 h-3.5 w-3.5" /> Auto-suggest
                  competitors
                </>
              )}
            </Button>
          </div>
          <Textarea
            id="competitorUrls"
            placeholder={"competitor1.com\ncompetitor2.com"}
            value={competitorText}
            onChange={(e) => setCompetitorText(e.target.value)}
            disabled={running}
            rows={5}
          />
          <p className="text-xs text-ink-3">
            {competitors.length} competitor
            {competitors.length === 1 ? "" : "s"}
            {seedKeywordsFromContext.length > 0
              ? ` · auto-suggest will use ${seedKeywordsFromContext.length} seed keyword${seedKeywordsFromContext.length === 1 ? "" : "s"} (from ${state.auditResult?.gscData ? "GSC top queries" : "existing target keywords"})`
              : " · run the Audit first or paste keywords to enable auto-suggest"}
          </p>
        </div>

        {errorMessage && (
          <p className="text-sm text-destructive" role="alert">
            {errorMessage}
          </p>
        )}

        <div className="flex justify-end border-t pt-4">
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
      </section>

      {state.compAnalysisRows && state.compAnalysisRows.length > 0 && (
        <CompResults
          rows={state.compAnalysisRows}
          warnings={state.compAnalysisWarnings}
          onDownload={downloadCsv}
        />
      )}
    </div>
  )
}

function CompResults({
  rows,
  warnings,
  onDownload,
}: {
  rows: CompAnalysisLocationRows[]
  warnings: string[]
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

      {warnings.length > 0 && (
        <div className="space-y-1 rounded-md border border-amber-400/50 bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-900/20 dark:text-amber-200">
          <strong>Warnings</strong>
          <ul className="list-inside list-disc">
            {Array.from(new Set(warnings)).slice(0, 5).map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-xs text-ink-3">
        Note: &ldquo;Pages Indexed&rdquo; uses Google&apos;s <code>site:</code>
        {" "}operator and is approximate.
      </p>

      <div className="space-y-6">
        {rows.map((loc) => (
          <LocationTable key={loc.location} location={loc} />
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
        {location.granularity === "city" ? (
          <span
            className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-bold tracking-[0.16em] text-emerald-700 dark:text-emerald-300"
            title="DataForSEO returned city-level metrics for this location."
          >
            city-level
          </span>
        ) : (
          <span
            className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-bold tracking-[0.16em] text-amber-700 dark:text-amber-300"
            title="DataForSEO doesn't have city-level data for this city — metrics rolled up to state level."
          >
            state-level fallback
          </span>
        )}
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
