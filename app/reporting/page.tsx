"use client"

import { useCallback, useMemo, useState } from "react"
import type { DateRange } from "react-day-picker"
import { marked } from "marked"
import ReactMarkdown from "react-markdown"
import { CalendarIcon, DownloadIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useSelectedPartner } from "@/lib/use-selected-partner"
import { cn } from "@/lib/utils"
import type {
  GSCDailyRow,
  GSCTopPageRow,
  GSCTopQueryRow,
  Partner,
} from "@/lib/types"

type Phase =
  | { status: "idle" }
  | { status: "fetching-gsc" }
  | { status: "generating" }
  | { status: "done"; report: string; partnerName: string; range: DateRange }
  | { status: "error"; message: string }

interface GscReportData {
  topQueries: GSCTopQueryRow[]
  topPages: GSCTopPageRow[]
  dailyClicks: GSCDailyRow[]
}

function iso(d: Date): string {
  // Use local-calendar date so the range matches what the user picked.
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

function defaultRange(): DateRange {
  const to = new Date()
  const from = new Date()
  from.setDate(to.getDate() - 29) // last 30 days inclusive
  return { from, to }
}

function formatRange(range: DateRange | undefined): string {
  if (!range?.from) return "Pick a date range"
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    })
  if (!range.to) return fmt(range.from)
  return `${fmt(range.from)} – ${fmt(range.to)}`
}

function partnerWebsiteToGscSiteUrl(website: string): string {
  let url = website.trim()
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`
  if (!url.endsWith("/")) url = `${url}/`
  return url
}

function triggerHtmlDownload(
  report: string,
  partnerName: string,
  range: DateRange,
) {
  const title = `${partnerName} — Performance Report`
  const rangeStr =
    range.from && range.to
      ? `${iso(range.from)} to ${iso(range.to)}`
      : "Custom range"
  const bodyHtml = marked.parse(report, { async: false }) as string
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} (${escapeHtml(rangeStr)})</title>
<style>
  body { font: 15px/1.55 ui-sans-serif, system-ui, sans-serif; color: #111827; max-width: 780px; margin: 3rem auto; padding: 0 1.5rem; }
  h1 { font-size: 1.75rem; margin: 0 0 0.5rem; }
  h2 { font-size: 1.15rem; margin: 1.75rem 0 0.5rem; border-bottom: 1px solid #e5e7eb; padding-bottom: 0.25rem; }
  h3 { font-size: 1rem; margin: 1.25rem 0 0.5rem; }
  p, li { margin: 0.4rem 0; }
  ul, ol { padding-left: 1.4rem; }
  table { border-collapse: collapse; width: 100%; margin: 0.75rem 0; font-size: 14px; }
  th, td { border: 1px solid #e5e7eb; padding: 6px 10px; text-align: left; }
  th { background: #f9fafb; }
  code { background: #f3f4f6; padding: 0 4px; border-radius: 3px; font-size: 0.9em; }
  footer { margin-top: 3rem; color: #6b7280; font-size: 0.85rem; border-top: 1px solid #e5e7eb; padding-top: 0.75rem; }
</style>
</head>
<body>
<article>${bodyHtml}</article>
<footer>Generated ${new Date().toLocaleString()} · ${escapeHtml(rangeStr)}</footer>
</body>
</html>`

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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

export default function ReportingPage() {
  const { partner, loading: partnerLoading, error: partnerError } =
    useSelectedPartner()
  const [range, setRange] = useState<DateRange | undefined>(defaultRange)
  const [phase, setPhase] = useState<Phase>({ status: "idle" })
  const [popoverOpen, setPopoverOpen] = useState(false)

  const canGenerate = useMemo(
    () =>
      !!partner &&
      !!range?.from &&
      !!range?.to &&
      (phase.status === "idle" ||
        phase.status === "done" ||
        phase.status === "error"),
    [partner, range, phase.status],
  )

  const siteUrl = useMemo(
    () => (partner ? partnerWebsiteToGscSiteUrl(partner.website) : null),
    [partner],
  )

  const handleGenerate = useCallback(async () => {
    if (!partner || !range?.from || !range?.to || !siteUrl) return
    const startDate = iso(range.from)
    const endDate = iso(range.to)

    setPhase({ status: "fetching-gsc" })
    let gscData: GscReportData
    try {
      const response = await fetch("/api/gsc/report-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteUrl, startDate, endDate }),
      })
      const body = (await response.json().catch(() => ({}))) as {
        topQueries?: GSCTopQueryRow[]
        topPages?: GSCTopPageRow[]
        dailyClicks?: GSCDailyRow[]
        error?: string
        code?: string
      }
      if (!response.ok) {
        if (body.code === "NO_REFRESH_TOKEN") {
          throw new Error(
            "GSC is not connected. Visit /api/gsc/auth to complete the OAuth flow and paste the refresh token into Vercel as GOOGLE_REFRESH_TOKEN.",
          )
        }
        throw new Error(body.error ?? `GSC request failed (${response.status})`)
      }
      gscData = {
        topQueries: body.topQueries ?? [],
        topPages: body.topPages ?? [],
        dailyClicks: body.dailyClicks ?? [],
      }
    } catch (err: unknown) {
      setPhase({
        status: "error",
        message: err instanceof Error ? err.message : "Failed to fetch GSC data",
      })
      return
    }

    if (
      gscData.topQueries.length === 0 &&
      gscData.topPages.length === 0 &&
      gscData.dailyClicks.length === 0
    ) {
      setPhase({
        status: "error",
        message: `No GSC data returned for siteUrl "${siteUrl}" in this range. Verify the partner's website matches one of the properties at /api/gsc/sites, or try a different date range.`,
      })
      return
    }

    setPhase({ status: "generating" })
    try {
      const response = await fetch("/api/claude/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          partner,
          gscData,
          dateRange: { start: startDate, end: endDate },
        }),
      })
      const body = (await response.json().catch(() => ({}))) as {
        report?: string
        error?: string
      }
      if (!response.ok || !body.report) {
        throw new Error(
          body.error ?? `Claude request failed (${response.status})`,
        )
      }
      setPhase({
        status: "done",
        report: body.report,
        partnerName: partner.name,
        range: { from: range.from, to: range.to },
      })
    } catch (err: unknown) {
      setPhase({
        status: "error",
        message:
          err instanceof Error ? err.message : "Failed to generate report",
      })
    }
  }, [partner, range, siteUrl])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Reporting</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Generate a monthly performance narrative from Google Search Console
          data for the selected partner.
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
          <section className="flex flex-wrap items-end gap-3 rounded-lg border p-4">
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                Date range
              </span>
              <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      "w-[280px] justify-start text-left font-normal",
                      !range?.from && "text-muted-foreground",
                    )}
                  >
                    <CalendarIcon className="mr-2 size-4" />
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

            <Button
              onClick={handleGenerate}
              disabled={!canGenerate}
              className="ml-auto"
            >
              {phase.status === "fetching-gsc"
                ? "Pulling GSC data…"
                : phase.status === "generating"
                  ? "Generating report…"
                  : "Generate Report"}
            </Button>
          </section>

          <PartnerSiteHint partner={partner} siteUrl={siteUrl} />

          <Status phase={phase} />

          {phase.status === "done" ? (
            <ReportView
              report={phase.report}
              onDownload={() =>
                triggerHtmlDownload(phase.report, phase.partnerName, phase.range)
              }
            />
          ) : null}
        </>
      )}
    </div>
  )
}

function PartnerSiteHint({
  partner,
  siteUrl,
}: {
  partner: Partner
  siteUrl: string | null
}) {
  if (!siteUrl) return null
  return (
    <p className="text-xs text-muted-foreground">
      {partner.name} · GSC siteUrl: <code className="text-foreground">{siteUrl}</code>
      {" · "}
      If this doesn&apos;t match a property, check what&apos;s available at{" "}
      <code>/api/gsc/sites</code>.
    </p>
  )
}

function Status({ phase }: { phase: Phase }) {
  if (phase.status === "fetching-gsc") {
    return (
      <p className="text-sm text-muted-foreground" aria-live="polite">
        Pulling GSC data…
      </p>
    )
  }
  if (phase.status === "generating") {
    return (
      <p className="text-sm text-muted-foreground" aria-live="polite">
        Generating report…
      </p>
    )
  }
  if (phase.status === "error") {
    return (
      <p
        className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
        role="alert"
      >
        {phase.message}
      </p>
    )
  }
  return null
}

function ReportView({
  report,
  onDownload,
}: {
  report: string
  onDownload: () => void
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">Report</h2>
        <Button variant="outline" size="sm" onClick={onDownload}>
          <DownloadIcon className="mr-2 size-4" />
          Download as HTML
        </Button>
      </div>
      <article className="rounded-lg border bg-card p-6">
        <ReactMarkdown
          components={{
            h1: ({ children }) => (
              <h1 className="mb-2 text-2xl font-semibold">{children}</h1>
            ),
            h2: ({ children }) => (
              <h2 className="mt-6 mb-2 border-b pb-1 text-lg font-semibold">
                {children}
              </h2>
            ),
            h3: ({ children }) => (
              <h3 className="mt-4 mb-1 text-base font-semibold">{children}</h3>
            ),
            p: ({ children }) => (
              <p className="my-2 text-sm leading-relaxed">{children}</p>
            ),
            ul: ({ children }) => (
              <ul className="my-2 list-disc space-y-1 pl-5 text-sm">{children}</ul>
            ),
            ol: ({ children }) => (
              <ol className="my-2 list-decimal space-y-1 pl-5 text-sm">{children}</ol>
            ),
            li: ({ children }) => <li className="leading-relaxed">{children}</li>,
            strong: ({ children }) => (
              <strong className="font-semibold">{children}</strong>
            ),
            code: ({ children }) => (
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
                {children}
              </code>
            ),
          }}
        >
          {report}
        </ReactMarkdown>
      </article>
    </section>
  )
}
