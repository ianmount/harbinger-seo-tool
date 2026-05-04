"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import type { DateRange } from "react-day-picker"
import { marked } from "marked"
import ReactMarkdown from "react-markdown"
import { CalendarIcon, DownloadIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { findGscSiteCandidates } from "@/lib/gsc-site-match"
import { findGa4PropertyCandidates } from "@/lib/ga4-site-match"
import { cn } from "@/lib/utils"
import type {
  GA4PropertyInfo,
  GA4SeoReport,
  GSCDailyRow,
  GSCSiteInfo,
  GSCTopPageRow,
  GSCTopQueryRow,
  Partner,
} from "@/lib/types"

type Phase =
  | { status: "idle" }
  | { status: "fetching-gsc" }
  | { status: "fetching-ga4" }
  | { status: "generating" }
  | {
      status: "done"
      report: string
      range: DateRange
      ga4Included: boolean
    }
  | { status: "error"; message: string }

type SitesState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; candidates: GSCSiteInfo[] }

type Ga4State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready"
      candidates: GA4PropertyInfo[]
      source: "airtable" | "auto" | "none"
    }

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

function defaultRange(): DateRange {
  const to = new Date()
  const from = new Date()
  from.setDate(to.getDate() - 29)
  return { from, to }
}

function formatRange(range: DateRange | undefined): string {
  if (!range?.from) return "Pick a date range"
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
  if (!range.to) return fmt(range.from)
  return `${fmt(range.from)} – ${fmt(range.to)}`
}

function priorPeriod(startDate: string, endDate: string) {
  const start = new Date(`${startDate}T00:00:00`)
  const end = new Date(`${endDate}T00:00:00`)
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1
  const priorEnd = new Date(start)
  priorEnd.setDate(priorEnd.getDate() - 1)
  const priorStart = new Date(priorEnd)
  priorStart.setDate(priorStart.getDate() - (days - 1))
  return { startDate: iso(priorStart), endDate: iso(priorEnd) }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
}

function triggerHtmlDownload(report: string, partnerName: string, range: DateRange) {
  const title = `${partnerName} — Performance Report`
  const rangeStr =
    range.from && range.to
      ? `${iso(range.from)} to ${iso(range.to)}`
      : "Custom range"
  const bodyHtml = marked.parse(report, { async: false }) as string
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font:15px/1.55 ui-sans-serif,system-ui,sans-serif;color:#111827;max-width:780px;margin:3rem auto;padding:0 1.5rem}h1{font-size:1.75rem;margin:0 0 .5rem}h2{font-size:1.15rem;margin:1.75rem 0 .5rem;border-bottom:1px solid #e5e7eb;padding-bottom:.25rem}table{border-collapse:collapse;width:100%;font-size:14px}th,td{border:1px solid #e5e7eb;padding:6px 10px;text-align:left}th{background:#f9fafb}footer{margin-top:3rem;color:#6b7280;font-size:.85rem;border-top:1px solid #e5e7eb;padding-top:.75rem}</style></head><body><article>${bodyHtml}</article><footer>Generated ${new Date().toLocaleString()} · ${escapeHtml(rangeStr)}</footer></body></html>`
  const blob = new Blob([html], { type: "text/html;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `${slugify(partnerName)}-report-${iso(range.from ?? new Date())}.html`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export function PartnerReportSection({ partner }: { partner: Partner }) {
  const [range, setRange] = useState<DateRange | undefined>(defaultRange)
  const [phase, setPhase] = useState<Phase>({ status: "idle" })
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [sitesState, setSitesState] = useState<SitesState>({ status: "idle" })
  const [chosenSiteUrl, setChosenSiteUrl] = useState<string | null>(null)
  const [ga4State, setGa4State] = useState<Ga4State>({ status: "idle" })
  const [chosenGa4PropertyId, setChosenGa4PropertyId] = useState<string | null>(null)

  useEffect(() => {
    const abort = new AbortController()
    setSitesState({ status: "loading" })
    fetch("/api/gsc/sites", { signal: abort.signal })
      .then((r) => r.json())
      .then((body: { sites?: GSCSiteInfo[]; error?: string }) => {
        if (!body.sites) throw new Error(body.error ?? "Failed")
        const candidates = findGscSiteCandidates(partner.website, body.sites)
        setSitesState({ status: "ready", candidates })
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return
        setSitesState({
          status: "error",
          message: err instanceof Error ? err.message : "Failed to load GSC sites",
        })
      })
    return () => abort.abort()
  }, [partner.website])

  useEffect(() => {
    const abort = new AbortController()
    setGa4State({ status: "loading" })
    const airtableOverride = partner.ga4PropertyId
    fetch("/api/ga4/properties", { signal: abort.signal })
      .then((r) => r.json())
      .then((body: { properties?: GA4PropertyInfo[]; error?: string }) => {
        const all = body.properties ?? []
        if (airtableOverride) {
          const normalized = airtableOverride.startsWith("properties/")
            ? airtableOverride
            : `properties/${airtableOverride}`
          const found = all.find((p) => p.propertyId === normalized)
          setGa4State({
            status: "ready",
            source: "airtable",
            candidates: found
              ? [found]
              : [{ propertyId: normalized, displayName: "(from Airtable)" }],
          })
          return
        }
        const matched = findGa4PropertyCandidates(partner.website, all)
        setGa4State({
          status: "ready",
          source: matched.length > 0 ? "auto" : "none",
          candidates: matched,
        })
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return
        if (airtableOverride) {
          const normalized = airtableOverride.startsWith("properties/")
            ? airtableOverride
            : `properties/${airtableOverride}`
          setGa4State({
            status: "ready",
            source: "airtable",
            candidates: [{ propertyId: normalized, displayName: "(from Airtable)" }],
          })
          return
        }
        setGa4State({
          status: "error",
          message: err instanceof Error ? err.message : "Failed",
        })
      })
    return () => abort.abort()
  }, [partner.website, partner.ga4PropertyId])

  useEffect(() => {
    if (sitesState.status === "ready") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setChosenSiteUrl(sitesState.candidates[0]?.siteUrl ?? null)
    }
  }, [sitesState])

  useEffect(() => {
    if (ga4State.status === "ready") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setChosenGa4PropertyId(ga4State.candidates[0]?.propertyId ?? null)
    }
  }, [ga4State])

  const canGenerate = useMemo(
    () =>
      !!range?.from &&
      !!range?.to &&
      !!chosenSiteUrl &&
      phase.status !== "fetching-gsc" &&
      phase.status !== "fetching-ga4" &&
      phase.status !== "generating",
    [range, chosenSiteUrl, phase.status],
  )

  const handleGenerate = useCallback(async () => {
    if (!range?.from || !range?.to || !chosenSiteUrl) return
    const startDate = iso(range.from)
    const endDate = iso(range.to)

    setPhase({ status: "fetching-gsc" })
    let gscData: {
      topQueries: GSCTopQueryRow[]
      topPages: GSCTopPageRow[]
      dailyClicks: GSCDailyRow[]
    }
    try {
      const r = await fetch("/api/gsc/report-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteUrl: chosenSiteUrl, startDate, endDate }),
      })
      const body = (await r.json()) as {
        topQueries?: GSCTopQueryRow[]
        topPages?: GSCTopPageRow[]
        dailyClicks?: GSCDailyRow[]
        error?: string
        code?: string
      }
      if (!r.ok) {
        if (body.code === "NO_REFRESH_TOKEN") {
          throw new Error("GSC is not connected. Visit /api/gsc/auth to complete the OAuth flow.")
        }
        throw new Error(body.error ?? `GSC request failed (${r.status})`)
      }
      if (
        !body.topQueries?.length &&
        !body.topPages?.length &&
        !body.dailyClicks?.length
      ) {
        throw new Error(
          `No GSC data for "${chosenSiteUrl}" in this range. Try a wider date range.`,
        )
      }
      gscData = {
        topQueries: body.topQueries ?? [],
        topPages: body.topPages ?? [],
        dailyClicks: body.dailyClicks ?? [],
      }
    } catch (err) {
      setPhase({ status: "error", message: err instanceof Error ? err.message : "GSC failed" })
      return
    }

    let ga4Data: GA4SeoReport | undefined
    let ga4PriorData: GA4SeoReport | undefined
    if (chosenGa4PropertyId) {
      setPhase({ status: "fetching-ga4" })
      try {
        const r = await fetch("/api/ga4/report", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ propertyId: chosenGa4PropertyId, startDate, endDate }),
        })
        const body = (await r.json()) as GA4SeoReport | { error?: string }
        if (r.ok && "propertyId" in body) {
          ga4Data = body
          const prior = priorPeriod(startDate, endDate)
          try {
            const pr = await fetch("/api/ga4/report", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                propertyId: chosenGa4PropertyId,
                startDate: prior.startDate,
                endDate: prior.endDate,
              }),
            })
            const prBody = (await pr.json()) as GA4SeoReport | { error?: string }
            if (pr.ok && "propertyId" in prBody) ga4PriorData = prBody
          } catch {
            // prior period is best-effort
          }
        }
      } catch {
        // GA4 is additive — fall through to GSC-only
      }
    }

    setPhase({ status: "generating" })
    try {
      const r = await fetch("/api/claude/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          partner,
          gscData,
          ga4Data,
          ga4PriorData,
          dateRange: { start: startDate, end: endDate },
        }),
      })
      const body = (await r.json()) as { report?: string; error?: string }
      if (!r.ok || !body.report) {
        throw new Error(body.error ?? `Claude request failed (${r.status})`)
      }
      setPhase({
        status: "done",
        report: body.report,
        range: { from: range.from, to: range.to },
        ga4Included: Boolean(ga4Data),
      })
    } catch (err) {
      setPhase({ status: "error", message: err instanceof Error ? err.message : "Claude failed" })
    }
  }, [partner, range, chosenSiteUrl, chosenGa4PropertyId])

  return (
    <section className="space-y-4">
      <h3 className="font-sans text-xs font-extrabold uppercase tracking-[0.18em] text-muted-foreground">
        Generate Performance Report
      </h3>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border p-3">
        {/* Date range */}
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Date range</span>
          <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                className={cn(
                  "h-8 w-[240px] justify-start text-left text-xs font-normal",
                  !range?.from && "text-muted-foreground",
                )}
              >
                <CalendarIcon className="mr-2 size-3.5" />
                {formatRange(range)}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="range"
                selected={range}
                onSelect={setRange}
                numberOfMonths={2}
                defaultMonth={range?.from}
              />
            </PopoverContent>
          </Popover>
        </div>

        {/* GSC property */}
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">GSC property</span>
          {sitesState.status === "loading" || sitesState.status === "idle" ? (
            <div className="h-8 w-[280px] rounded-md border px-3 py-2 text-xs text-muted-foreground">
              Loading GSC…
            </div>
          ) : sitesState.status === "error" ? (
            <div className="h-8 w-[280px] rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {sitesState.message}
            </div>
          ) : sitesState.candidates.length === 0 ? (
            <div className="h-8 w-[280px] rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              No GSC property matched
            </div>
          ) : (
            <Select value={chosenSiteUrl ?? ""} onValueChange={setChosenSiteUrl}>
              <SelectTrigger className="h-8 w-[280px] text-xs" aria-label="GSC property">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sitesState.candidates.map((s) => (
                  <SelectItem key={s.siteUrl} value={s.siteUrl} className="text-xs">
                    <span className="font-mono">{s.siteUrl}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {/* GA4 property */}
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">GA4 property</span>
          {ga4State.status === "loading" || ga4State.status === "idle" ? (
            <div className="h-8 w-[220px] rounded-md border px-3 py-2 text-xs text-muted-foreground">
              Resolving GA4…
            </div>
          ) : ga4State.status === "error" ? (
            <div
              className="h-8 w-[220px] rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-900 dark:text-amber-200"
              title={ga4State.message}
            >
              GA4 unavailable — GSC only
            </div>
          ) : ga4State.source === "none" ? (
            <Badge
              variant="outline"
              className="h-8 whitespace-nowrap px-3 text-xs text-muted-foreground"
            >
              GA4 not configured
            </Badge>
          ) : (
            <div className="flex items-center gap-2">
              <Select
                value={chosenGa4PropertyId ?? ""}
                onValueChange={setChosenGa4PropertyId}
              >
                <SelectTrigger className="h-8 w-[220px] text-xs" aria-label="GA4 property">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ga4State.candidates.map((p) => (
                    <SelectItem key={p.propertyId} value={p.propertyId} className="text-xs">
                      {p.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Badge variant="secondary" className="text-[10px]">
                {ga4State.source === "airtable" ? "Airtable" : "auto"}
              </Badge>
            </div>
          )}
        </div>

        <Button
          size="sm"
          onClick={handleGenerate}
          disabled={!canGenerate}
          className="ml-auto h-8"
        >
          {phase.status === "fetching-gsc"
            ? "Pulling GSC…"
            : phase.status === "fetching-ga4"
              ? "Pulling GA4…"
              : phase.status === "generating"
                ? "Generating…"
                : "Generate Report"}
        </Button>
      </div>

      {phase.status === "error" && (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert">
          {phase.message}
        </p>
      )}

      {phase.status === "done" && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {phase.ga4Included ? "GSC + GA4 report" : "GSC-only report"} ·{" "}
              {formatRange(phase.range)}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() =>
                triggerHtmlDownload(phase.report, partner.name, phase.range)
              }
            >
              <DownloadIcon className="mr-1.5 size-3" />
              Download HTML
            </Button>
          </div>
          <article className="max-h-[600px] overflow-auto rounded-lg border bg-card p-5">
            <ReactMarkdown
              components={{
                h1: ({ children }) => <h1 className="mb-2 text-xl font-semibold">{children}</h1>,
                h2: ({ children }) => <h2 className="mt-5 mb-1.5 border-b pb-1 text-base font-semibold">{children}</h2>,
                h3: ({ children }) => <h3 className="mt-3 mb-1 text-sm font-semibold">{children}</h3>,
                p: ({ children }) => <p className="my-1.5 text-sm leading-relaxed">{children}</p>,
                ul: ({ children }) => <ul className="my-1.5 list-disc space-y-0.5 pl-5 text-sm">{children}</ul>,
                ol: ({ children }) => <ol className="my-1.5 list-decimal space-y-0.5 pl-5 text-sm">{children}</ol>,
                li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                code: ({ children }) => (
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
                    {children}
                  </code>
                ),
              }}
            >
              {phase.report}
            </ReactMarkdown>
          </article>
        </div>
      )}
    </section>
  )
}
