"use client"

import { Suspense, useCallback, useEffect, useMemo, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { DownloadIcon, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { JobsForKindCard } from "@/components/JobsForKindCard"
import { ensureNotificationPermission } from "@/components/JobsTray"
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
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useSelectedPartner } from "@/lib/use-selected-partner"
import type {
  CarryoverRecommendation,
  ContentCarryover,
  InitialStrategyOutput,
  Partner,
} from "@/lib/types"

/**
 * Onboarding → Initial Strategy.
 *
 * Inputs: approved sitemap (indented text) + approved keyword list (CSV with
 * a "Keyword" column or one keyword per line). Backend orchestrates a full
 * crawl of the partner's current site, parses the sitemap, and asks Claude
 * to produce three coordinated outputs.
 *
 * Outputs render as preview tables; engineer downloads a 3-sheet XLSX once
 * they're satisfied. The XLSX is generated in the browser via dynamic import
 * of `lib/xlsx-export` so the heavy ExcelJS bundle only loads on download.
 */

interface JobShape {
  id: string
  status: "queued" | "running" | "completed" | "failed" | "cancelled"
  title: string
  result: { strategy: InitialStrategyOutput } | null
  progress: { stage?: string; detail?: string }
  error: string | null
}

const SITEMAP_PLACEHOLDER = `Home
Services
  Plumbing
    Drain Cleaning
    Water Heater Repair
  HVAC
    AC Repair
    Furnace Installation
About
  Our Team
Service Areas
  Atlanta
  Marietta
Blog
Contact`

const KEYWORDS_PLACEHOLDER = `Keyword
emergency plumber atlanta
drain cleaning service
water heater repair near me
hvac repair atlanta
…`

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

function formatCurrency(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`
  return `$${n.toFixed(2)}`
}

function InitialStrategyPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const jobId = searchParams.get("job") ?? null

  const { partner, loading: partnerLoading, error: partnerError } =
    useSelectedPartner()
  const [sitemapText, setSitemapText] = useState("")
  const [keywordsText, setKeywordsText] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [downloading, setDownloading] = useState(false)

  // Job polling — same pattern as /tools/alt-tags.
  const [job, setJob] = useState<JobShape | null>(null)
  const [jobLoadError, setJobLoadError] = useState<string | null>(null)
  useEffect(() => {
    if (!jobId) {
      setJob(null)
      setJobLoadError(null)
      return
    }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" })
        if (cancelled) return
        if (res.status === 404) {
          setJobLoadError("Job not found.")
          return
        }
        if (!res.ok) {
          setJobLoadError(`Failed to load job (HTTP ${res.status}).`)
          return
        }
        const body = (await res.json()) as { job: JobShape }
        setJob(body.job)
        if (body.job.status === "queued" || body.job.status === "running") {
          timer = setTimeout(tick, 3000)
        }
      } catch (err) {
        if (cancelled) return
        setJobLoadError(
          err instanceof Error ? err.message : "Network error",
        )
      }
    }
    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [jobId])

  const canRun =
    !!partner &&
    sitemapText.trim().length > 0 &&
    keywordsText.trim().length > 0 &&
    !submitting

  const sitemapStats = useMemo(() => {
    const lines = sitemapText.split(/\r?\n/).filter((l) => {
      const t = l.trim()
      return t.length > 0 && !t.startsWith("#") && !t.startsWith("//")
    })
    return { lines: lines.length }
  }, [sitemapText])

  const keywordStats = useMemo(() => {
    const lines = keywordsText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"))
    if (lines.length === 0) return { count: 0, hasHeader: false }
    const first = lines[0].split(",").map((c) => c.trim().toLowerCase())
    const hasHeader = first.includes("keyword") || first.includes("keywords")
    return { count: hasHeader ? Math.max(0, lines.length - 1) : lines.length, hasHeader }
  }, [keywordsText])

  const handleRun = useCallback(async () => {
    if (!partner) return
    setSubmitting(true)
    setSubmitError(null)
    void ensureNotificationPermission()
    try {
      const res = await fetch("/api/jobs/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "initial_strategy",
          title: `Initial Strategy — ${partner.name}`,
          input: {
            partnerId: partner.id,
            sitemapText,
            keywordsText,
          },
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const { jobId: newJobId } = (await res.json()) as { jobId: string }
      toast.success("Strategy started — we'll email you when it's ready.")
      router.push(`/onboarding/initial-strategy?job=${newJobId}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error"
      setSubmitError(message)
      toast.error("Could not start", { description: message })
    } finally {
      setSubmitting(false)
    }
  }, [partner, sitemapText, keywordsText, router])

  const result = job?.result?.strategy ?? null

  const handleDownload = useCallback(async () => {
    if (!result) return
    setDownloading(true)
    try {
      const [{ buildInitialStrategyWorkbook, workbookToArrayBuffer }] =
        await Promise.all([import("@/lib/xlsx-export")])
      const wb = buildInitialStrategyWorkbook(result)
      const buf = await workbookToArrayBuffer(wb)
      const blob = new Blob([buf], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      const stamp = new Date().toISOString().slice(0, 10)
      const slug = slugify(result.partnerName) || "partner"
      a.href = url
      a.download = `${slug}-initial-strategy-${stamp}.xlsx`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } finally {
      setDownloading(false)
    }
  }, [result])

  const showForm = !jobId

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Onboarding / Initial Strategy"
        title="Initial Strategy"
        tail="— brief the new-site build."
        subtitle={
          <>
            Turn an approved sitemap and keyword list into the three artifacts a
            developer needs to ship the new site:{" "}
            <b className="font-sans font-extrabold not-italic text-foreground">
              keyword‑to‑page mapping
            </b>
            ,{" "}
            <b className="font-sans font-extrabold not-italic text-foreground">
              URL redirect map
            </b>{" "}
            (current site → new site), and an{" "}
            <b className="font-sans font-extrabold not-italic text-foreground">
              internal linking plan
            </b>
            . Output is a single XLSX with three sheets.
          </>
        }
      />

      {partnerLoading ? (
        <p className="text-sm text-muted-foreground">Loading partner…</p>
      ) : partnerError ? (
        <p className="text-sm text-destructive" role="alert">
          {partnerError}
        </p>
      ) : !partner && showForm ? (
        <p className="text-sm text-muted-foreground">
          Please select a partner from the dropdown above.
        </p>
      ) : (
        <>
          {partner && showForm && <PartnerSummary partner={partner} />}

          {showForm && (
            <>
              <section className="space-y-3 rounded-lg border p-4">
                <Label htmlFor="sitemap">Approved new-site sitemap (indented)</Label>
                <Textarea
                  id="sitemap"
                  placeholder={SITEMAP_PLACEHOLDER}
                  value={sitemapText}
                  onChange={(e) => setSitemapText(e.target.value)}
                  className="min-h-[180px] font-mono text-xs"
                  disabled={submitting}
                />
                <p className="text-xs text-muted-foreground">
                  One page per line. Indent with tabs or 2/4 spaces to nest.
                  Top-level page named &ldquo;Home&rdquo; maps to{" "}
                  <code className="font-mono">/</code>.{" "}
                  {sitemapStats.lines > 0 ? (
                    <>
                      <strong>{sitemapStats.lines}</strong> page line
                      {sitemapStats.lines === 1 ? "" : "s"} detected.
                    </>
                  ) : null}
                </p>
              </section>

              <section className="space-y-3 rounded-lg border p-4">
                <Label htmlFor="keywords">Approved keyword list</Label>
                <Textarea
                  id="keywords"
                  placeholder={KEYWORDS_PLACEHOLDER}
                  value={keywordsText}
                  onChange={(e) => setKeywordsText(e.target.value)}
                  className="min-h-[180px] font-mono text-xs"
                  disabled={submitting}
                />
                <p className="text-xs text-muted-foreground">
                  Paste a CSV with a <code className="font-mono">Keyword</code>{" "}
                  column, or one keyword per line.{" "}
                  {keywordStats.count > 0 ? (
                    <>
                      <strong>{keywordStats.count}</strong> keyword
                      {keywordStats.count === 1 ? "" : "s"} detected
                      {keywordStats.hasHeader ? " (CSV header found)" : ""}.
                    </>
                  ) : null}
                </p>
              </section>

              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={handleRun} disabled={!canRun}>
                  {submitting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Starting…
                    </>
                  ) : (
                    "Generate Initial Strategy"
                  )}
                </Button>
              </div>

              {submitError ? (
                <p
                  className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
                  role="alert"
                >
                  {submitError}
                </p>
              ) : null}
            </>
          )}

          {jobId && (
            <JobPanel
              job={job}
              jobLoadError={jobLoadError}
              onNew={() => router.push("/onboarding/initial-strategy")}
            />
          )}

          {result ? (
            <ResultView
              result={result}
              onDownload={handleDownload}
              downloading={downloading}
            />
          ) : null}

          <JobsForKindCard
            kind="initial_strategy"
            title="Recent strategy runs"
          />
        </>
      )}
    </div>
  )
}

function JobPanel({
  job,
  jobLoadError,
  onNew,
}: {
  job: JobShape | null
  jobLoadError: string | null
  onNew: () => void
}) {
  if (jobLoadError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Couldn&apos;t load job</CardTitle>
          <CardDescription>{jobLoadError}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={onNew}>Start a new run</Button>
        </CardContent>
      </Card>
    )
  }
  if (!job) return null
  if (job.status === "queued" || job.status === "running") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{job.title}</CardTitle>
          <CardDescription>
            Running in the background. Crawling the site, pulling 180 days of
            GSC, and asking Claude to draft the three artifacts.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-2 text-sm">
            <Loader2 className="mt-0.5 h-4 w-4 animate-spin text-primary" />
            <div>
              <div className="font-medium">
                {job.progress?.stage ?? "Running…"}
              </div>
              {job.progress?.detail && (
                <div className="text-xs text-muted-foreground">
                  {job.progress.detail}
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    )
  }
  if (job.status === "failed") {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-destructive">Run failed</CardTitle>
          <CardDescription>{job.title}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <pre className="whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
            {job.error ?? "(no error message)"}
          </pre>
          <Button onClick={onNew}>Start a new run</Button>
        </CardContent>
      </Card>
    )
  }
  if (job.status === "cancelled") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Run cancelled</CardTitle>
          <CardDescription>{job.title}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={onNew}>Start a new run</Button>
        </CardContent>
      </Card>
    )
  }
  return null
}

export default function InitialStrategyPage() {
  return (
    <Suspense fallback={null}>
      <InitialStrategyPageInner />
    </Suspense>
  )
}

function PartnerSummary({ partner }: { partner: Partner }) {
  const unfilled = partner.unfilledContext ?? []
  return (
    <section className="space-y-3 rounded-lg border p-4">
      <div>
        <h2 className="text-lg font-medium">{partner.name}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          <a
            href={partner.website}
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-foreground"
          >
            {partner.website}
          </a>
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Services
          </h3>
          <p className="mt-1 whitespace-pre-wrap text-sm">{partner.services}</p>
        </div>
        <div>
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Service areas
          </h3>
          <p className="mt-1 whitespace-pre-wrap text-sm">
            {partner.serviceAreas}
          </p>
        </div>
      </div>
      {unfilled.length > 0 ? (
        <p
          className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-900 dark:text-amber-200"
          role="status"
        >
          Heads up: {unfilled.join(", ")} still contain template boilerplate in
          Airtable. Strategy quality improves when these are filled in.
        </p>
      ) : null}
    </section>
  )
}

function ResultView({
  result,
  onDownload,
  downloading,
}: {
  result: InitialStrategyOutput
  onDownload: () => void
  downloading: boolean
}) {
  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-medium">Strategy preview</h2>
          <Badge variant="secondary" className="text-[10px]">
            {result.crawledUrlCount} URLs crawled · {result.sitemapPageCount} sitemap pages
          </Badge>
          <Badge
            variant="secondary"
            className="text-[10px]"
            title={
              result.gscEnabled
                ? `${result.carryoverAnalyzedCount} pages cleared the last-${result.gscLookbackDays}-day GSC traffic floor.`
                : "GSC unavailable — carryover analysis ran on crawl metadata only."
            }
          >
            {result.gscEnabled
              ? `${result.carryoverAnalyzedCount}/${result.crawledUrlCount} carryover-analyzed`
              : "No GSC — metadata only"}
          </Badge>
          <Badge
            variant="secondary"
            className="text-[10px]"
            title="Estimated cost based on the actual Anthropic token usage."
          >
            ~{formatCurrency(result.costUsd)} · {result.durationSeconds.toFixed(1)}s
          </Badge>
        </div>
        <Button onClick={onDownload} disabled={downloading} size="sm">
          <DownloadIcon className="mr-2 size-4" />
          {downloading ? "Building XLSX…" : "Download XLSX"}
        </Button>
      </div>

      {result.gscNotice ? (
        <p
          className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-900 dark:text-amber-200"
          role="status"
        >
          {result.gscNotice}
        </p>
      ) : null}

      {result.warnings.length > 0 ? (
        <details className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
          <summary className="cursor-pointer font-medium text-amber-900 dark:text-amber-200">
            {result.warnings.length} validation warning
            {result.warnings.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      ) : null}

      <KeywordTable result={result} />
      <UrlTable result={result} />
      <LinkingTable result={result} />
      <CarryoverTable result={result} />
    </section>
  )
}

function KeywordTable({ result }: { result: InitialStrategyOutput }) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">
        Keyword‑to‑page mapping ({result.keywordMapping.length} pages)
      </h3>
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Page</TableHead>
              <TableHead>New URL</TableHead>
              <TableHead>Primary keyword</TableHead>
              <TableHead>Secondary keywords</TableHead>
              <TableHead>Rationale</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.keywordMapping.map((row) => (
              <TableRow key={row.pagePath}>
                <TableCell className="font-medium">{row.pagePath}</TableCell>
                <TableCell className="font-mono text-xs">{row.newUrl}</TableCell>
                <TableCell>{row.primaryKeyword}</TableCell>
                <TableCell className="text-xs">
                  {row.secondaryKeywords.join(", ")}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {row.rationale}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function UrlTable({ result }: { result: InitialStrategyOutput }) {
  const redirects = result.urlMapping.filter((r) => r.redirectType === "301").length
  const noRedirects = result.urlMapping.length - redirects
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">
        URL mapping ({result.urlMapping.length} URLs · {redirects} redirects · {noRedirects} retired/manual review)
      </h3>
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Old URL</TableHead>
              <TableHead>New URL</TableHead>
              <TableHead>Redirect</TableHead>
              <TableHead>Notes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.urlMapping.map((row) => (
              <TableRow
                key={row.oldUrl}
                className={
                  row.redirectType === "none" ? "bg-amber-500/5" : undefined
                }
              >
                <TableCell className="font-mono text-xs">{row.oldUrl}</TableCell>
                <TableCell className="font-mono text-xs">
                  {row.newUrl ?? "—"}
                </TableCell>
                <TableCell>
                  <Badge
                    variant={row.redirectType === "301" ? "default" : "secondary"}
                    className="text-[10px]"
                  >
                    {row.redirectType}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {row.notes}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

const RECOMMENDATION_ORDER: Record<CarryoverRecommendation, number> = {
  "port-as-is": 0,
  "port-and-refresh": 1,
  rewrite: 2,
  retire: 3,
}

const RECOMMENDATION_LABEL: Record<CarryoverRecommendation, string> = {
  "port-as-is": "Port as-is",
  "port-and-refresh": "Port & refresh",
  rewrite: "Rewrite",
  retire: "Retire",
}

function CarryoverTable({ result }: { result: InitialStrategyOutput }) {
  const sorted = useMemo(() => {
    return [...result.contentCarryover].sort((a, b) => {
      const recDelta =
        RECOMMENDATION_ORDER[a.recommendation] -
        RECOMMENDATION_ORDER[b.recommendation]
      if (recDelta !== 0) return recDelta
      // Within a bucket, push higher-traffic pages to the top.
      const aClicks = a.gsc?.clicks ?? 0
      const bClicks = b.gsc?.clicks ?? 0
      if (aClicks !== bClicks) return bClicks - aClicks
      const aImp = a.gsc?.impressions ?? 0
      const bImp = b.gsc?.impressions ?? 0
      return bImp - aImp
    })
  }, [result.contentCarryover])

  const counts = useMemo(() => {
    const c: Record<CarryoverRecommendation, number> = {
      "port-as-is": 0,
      "port-and-refresh": 0,
      rewrite: 0,
      retire: 0,
    }
    for (const row of result.contentCarryover) c[row.recommendation]++
    return c
  }, [result.contentCarryover])

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">
        Content carryover ({result.contentCarryover.length} pages ·{" "}
        {counts["port-as-is"]} port · {counts["port-and-refresh"]} refresh ·{" "}
        {counts.rewrite} rewrite · {counts.retire} retire)
      </h3>
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Old URL</TableHead>
              <TableHead>Recommendation</TableHead>
              <TableHead>Target</TableHead>
              <TableHead className="text-right">Clicks</TableHead>
              <TableHead className="text-right">Impressions</TableHead>
              <TableHead className="text-right">Position</TableHead>
              <TableHead className="text-right">Words</TableHead>
              <TableHead>Rationale</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((row) => (
              <CarryoverRow key={row.oldUrl} row={row} />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function CarryoverRow({ row }: { row: ContentCarryover }) {
  const isRetire = row.recommendation === "retire"
  return (
    <TableRow className={isRetire ? "bg-amber-500/5" : undefined}>
      <TableCell className="font-mono text-xs">
        <div className="font-medium">{row.oldUrl}</div>
        {row.title ? (
          <div className="font-sans text-[10px] text-muted-foreground">
            {row.title}
          </div>
        ) : null}
      </TableCell>
      <TableCell>
        <Badge
          variant={
            row.recommendation === "port-as-is"
              ? "default"
              : row.recommendation === "retire"
                ? "secondary"
                : "outline"
          }
          className="text-[10px]"
          title={row.autoGenerated ? "Auto-generated (no Claude tokens spent on this row)." : undefined}
        >
          {RECOMMENDATION_LABEL[row.recommendation]}
          {row.autoGenerated ? " ·  auto" : ""}
        </Badge>
      </TableCell>
      <TableCell className="font-mono text-xs">
        {row.newUrl ?? "—"}
      </TableCell>
      <TableCell className="text-right font-mono text-xs">
        {row.gsc ? row.gsc.clicks.toLocaleString() : "—"}
      </TableCell>
      <TableCell className="text-right font-mono text-xs">
        {row.gsc ? row.gsc.impressions.toLocaleString() : "—"}
      </TableCell>
      <TableCell className="text-right font-mono text-xs">
        {row.gsc ? row.gsc.position.toFixed(1) : "—"}
      </TableCell>
      <TableCell className="text-right font-mono text-xs">
        {row.wordCount.toLocaleString()}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {row.rationale}
      </TableCell>
    </TableRow>
  )
}

function LinkingTable({ result }: { result: InitialStrategyOutput }) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">
        Internal linking ({result.internalLinking.length} links)
      </h3>
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Source</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Anchor text</TableHead>
              <TableHead>Rationale</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.internalLinking.map((row, i) => (
              <TableRow key={`${row.sourcePath}-${row.targetPath}-${i}`}>
                <TableCell className="text-xs">
                  <div className="font-medium">{row.sourcePath}</div>
                  <div className="font-mono text-[10px] text-muted-foreground">
                    {row.sourceUrl}
                  </div>
                </TableCell>
                <TableCell className="text-xs">
                  <div className="font-medium">{row.targetPath}</div>
                  <div className="font-mono text-[10px] text-muted-foreground">
                    {row.targetUrl}
                  </div>
                </TableCell>
                <TableCell className="text-xs">{row.anchorText}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {row.rationale}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
