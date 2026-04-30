"use client"

import { Suspense, useCallback, useEffect, useMemo, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { DownloadIcon, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { JobsForKindCard } from "@/components/JobsForKindCard"
import { ensureNotificationPermission } from "@/components/JobsTray"
import { PageHeader } from "@/components/PageHeader"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

interface AltTagRow {
  pageUrl: string
  imageUrl: string
  currentAlt: string
  generatedAlt: string
  skipped: boolean
}

interface AltTagsResult {
  rows: AltTagRow[]
  pagesCrawled: number
  pagesWithImages: number
  imagesFound: number
  imagesProcessed: number
  durationMs: number
  costUsd: number
  dataforseoUsd: number
  claudeUsd: number
}

interface JobShape {
  id: string
  status: "queued" | "running" | "completed" | "failed" | "cancelled"
  title: string
  result: AltTagsResult | null
  progress: { stage?: string; detail?: string }
  error: string | null
  input: { domain?: string }
}

function csvEscape(value: unknown): string {
  if (value == null) return ""
  const s = String(value)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function rowsToCsv(rows: AltTagRow[]): string {
  const header = ["page_url", "image_url", "current_alt", "suggested_alt"]
  const lines = [header.map(csvEscape).join(",")]
  for (const r of rows) {
    lines.push(
      [r.pageUrl, r.imageUrl, r.currentAlt, r.generatedAlt]
        .map(csvEscape)
        .join(","),
    )
  }
  return lines.join("\n")
}

function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function safeFilenameFor(domain: string): string {
  const cleaned = domain
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .replace(/[^a-z0-9.-]/gi, "_")
    .toLowerCase()
  const stamp = new Date().toISOString().slice(0, 10)
  return `alt-tags-${cleaned}-${stamp}.csv`
}

function AltTagsPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const jobId = searchParams.get("job") ?? null

  const [domain, setDomain] = useState("")
  const [maxPages, setMaxPages] = useState<number>(200)
  const [skipImagesWithAlt, setSkipImagesWithAlt] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  // Polling: when ?job=<id> is present, fetch the job and refresh while
  // running. The page renders three states from this single source of
  // truth: in-progress, completed (table), error.
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

  const handleRun = useCallback(async () => {
    if (!domain.trim()) return
    setSubmitting(true)
    setSubmitError(null)
    void ensureNotificationPermission()
    try {
      const res = await fetch("/api/jobs/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "alt_tags",
          title: `Alt Tags — ${domain.trim()}`,
          input: {
            domain: domain.trim(),
            maxPages,
            skipImagesWithAlt,
          },
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const { jobId: newJobId } = (await res.json()) as { jobId: string }
      toast.success("Alt-tag generation started")
      router.push(`/tools/alt-tags?job=${newJobId}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error"
      setSubmitError(message)
      toast.error("Could not start", { description: message })
    } finally {
      setSubmitting(false)
    }
  }, [domain, maxPages, skipImagesWithAlt, router])

  const previewRows = useMemo(() => {
    return job?.result?.rows.slice(0, 50) ?? []
  }, [job])

  const handleDownload = useCallback(() => {
    if (!job?.result) return
    const dom = job.input.domain ?? "site"
    downloadCsv(safeFilenameFor(dom), rowsToCsv(job.result.rows))
  }, [job])

  const showForm = !jobId

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Tool / Alt Tag Generation"
        title="Alt Tag Generation"
        tail="— accessible, descriptive alt text for every image."
        subtitle={
          <>
            Paste a domain and we crawl the site with{" "}
            <b className="font-sans font-extrabold not-italic text-foreground">
              DataForSEO
            </b>
            , extract every <code className="font-mono text-[13px]">&lt;img&gt;</code>{" "}
            on each page, then ask{" "}
            <b className="font-sans font-extrabold not-italic text-foreground">
              Claude
            </b>{" "}
            to write descriptive, page-aware alt text. Runs as a background
            job — you&apos;ll get an email when it&apos;s done. Output is a
            CSV ready for the content team to apply.
          </>
        }
      />

      {showForm && (
        <section className="space-y-4 rounded-lg border p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="domain">Domain</Label>
              <Input
                id="domain"
                type="text"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="example.com"
                disabled={submitting}
              />
              <p className="text-xs text-muted-foreground">
                With or without <code className="font-mono">https://</code>. We
                auto-detect whether the site needs JavaScript rendering.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="max-pages">Max pages</Label>
              <Input
                id="max-pages"
                type="number"
                min={1}
                max={1000}
                value={maxPages}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  if (Number.isFinite(v)) setMaxPages(v)
                }}
                disabled={submitting}
              />
              <p className="text-xs text-muted-foreground">
                Cap on pages crawled (1-1000). Default 200.
              </p>
            </div>

            <label
              className="flex items-start gap-2 sm:col-span-2"
              htmlFor="skip-with-alt"
            >
              <input
                id="skip-with-alt"
                type="checkbox"
                checked={skipImagesWithAlt}
                onChange={(e) => setSkipImagesWithAlt(e.target.checked)}
                disabled={submitting}
                className="mt-1"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-medium leading-none">
                  Skip images that already have alt text
                </span>
                <span className="text-xs text-muted-foreground">
                  When checked, only generate suggestions for{" "}
                  <code className="font-mono">&lt;img&gt;</code> tags missing the{" "}
                  <code className="font-mono">alt</code> attribute or with empty
                  alt.
                </span>
              </span>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={handleRun} disabled={submitting || !domain.trim()}>
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Starting…
                </>
              ) : (
                "Generate alt tags"
              )}
            </Button>
          </div>

          {submitError && (
            <p
              className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
              role="alert"
            >
              {submitError}
            </p>
          )}
        </section>
      )}

      {jobId && (
        <JobPanel
          job={job}
          jobLoadError={jobLoadError}
          previewRows={previewRows}
          onDownload={handleDownload}
          onNew={() => {
            router.push("/tools/alt-tags")
          }}
        />
      )}

      <JobsForKindCard kind="alt_tags" title="Recent alt-tag runs" />
    </div>
  )
}

function JobPanel({
  job,
  jobLoadError,
  previewRows,
  onDownload,
  onNew,
}: {
  job: JobShape | null
  jobLoadError: string | null
  previewRows: AltTagRow[]
  onDownload: () => void
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
  if (!job) {
    return (
      <p className="font-serif text-[14px] italic text-ink-2">Loading job…</p>
    )
  }
  if (job.status === "queued" || job.status === "running") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{job.title}</CardTitle>
          <CardDescription>
            Running in the background. You can leave the tab — we&apos;ll
            email you when it&apos;s done.
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
  if (!job.result) {
    return (
      <p className="font-serif text-[14px] italic text-ink-2">
        Run completed but no result data — try starting a new run.
      </p>
    )
  }
  const result = job.result
  return (
    <section className="space-y-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="font-sans text-[16px] font-extrabold tracking-[-0.005em]">
            Results
          </h2>
          <p className="text-xs text-muted-foreground">
            Crawled <b>{result.pagesCrawled}</b> pages ·{" "}
            <b>{result.pagesWithImages}</b> with images · found{" "}
            <b>{result.imagesFound}</b> images · generated alt for{" "}
            <b>{result.imagesProcessed}</b> · cost{" "}
            <b>${result.costUsd.toFixed(3)}</b> · {Math.round(
              result.durationMs / 1000,
            )}
            s
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={onDownload}>
            <DownloadIcon /> Download CSV ({result.rows.length} rows)
          </Button>
          <Button variant="outline" onClick={onNew}>
            Start a new run
          </Button>
        </div>
      </div>

      {result.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No images found in the crawl. Try increasing <b>max pages</b> or
          confirm the domain is correct.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[28%]">Page</TableHead>
                <TableHead className="w-[28%]">Image</TableHead>
                <TableHead className="w-[20%]">Current alt</TableHead>
                <TableHead className="w-[24%]">Suggested alt</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {previewRows.map((r, i) => (
                <TableRow key={`${r.pageUrl}-${r.imageUrl}-${i}`}>
                  <TableCell className="break-all align-top text-[12px]">
                    <a
                      href={r.pageUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline"
                    >
                      {r.pageUrl}
                    </a>
                  </TableCell>
                  <TableCell className="break-all align-top text-[12px]">
                    <a
                      href={r.imageUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline"
                    >
                      {r.imageUrl}
                    </a>
                  </TableCell>
                  <TableCell className="align-top text-[12px] text-muted-foreground">
                    {r.currentAlt || "—"}
                  </TableCell>
                  <TableCell className="align-top text-[12px]">
                    {r.skipped ? (
                      <span className="text-muted-foreground italic">
                        skipped (already has alt)
                      </span>
                    ) : r.generatedAlt ? (
                      r.generatedAlt
                    ) : (
                      <span className="text-destructive italic">
                        (no suggestion)
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {result.rows.length > previewRows.length ? (
        <p className="text-xs text-muted-foreground">
          Showing first {previewRows.length} of {result.rows.length} rows.
          Download the CSV for the full list.
        </p>
      ) : null}
    </section>
  )
}

export default function AltTagsPage() {
  // useSearchParams must be inside a Suspense boundary in Next 16.
  return (
    <Suspense fallback={null}>
      <AltTagsPageInner />
    </Suspense>
  )
}
