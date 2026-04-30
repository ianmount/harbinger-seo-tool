"use client"

import { useCallback, useMemo, useState } from "react"
import { DownloadIcon } from "lucide-react"
import { PageHeader } from "@/components/PageHeader"
import { Button } from "@/components/ui/button"
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

interface ApiResult {
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

type Phase =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; result: ApiResult }
  | { status: "error"; message: string }

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

export default function AltTagsPage() {
  const [domain, setDomain] = useState("")
  const [maxPages, setMaxPages] = useState<number>(200)
  const [skipImagesWithAlt, setSkipImagesWithAlt] = useState(true)
  const [phase, setPhase] = useState<Phase>({ status: "idle" })

  const handleRun = useCallback(async () => {
    if (!domain.trim()) return
    setPhase({ status: "running" })
    try {
      const response = await fetch("/api/tools/alt-tags/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: domain.trim(),
          maxPages,
          skipImagesWithAlt,
        }),
      })
      const body = (await response.json().catch(() => ({}))) as
        | ApiResult
        | { error?: string }
      if (!response.ok) {
        const message =
          (body as { error?: string }).error ??
          `Request failed (${response.status})`
        setPhase({ status: "error", message })
        return
      }
      setPhase({ status: "done", result: body as ApiResult })
    } catch (err) {
      setPhase({
        status: "error",
        message: err instanceof Error ? err.message : "Network error",
      })
    }
  }, [domain, maxPages, skipImagesWithAlt])

  const handleDownload = useCallback(() => {
    if (phase.status !== "done") return
    const csv = rowsToCsv(phase.result.rows)
    downloadCsv(safeFilenameFor(domain), csv)
  }, [phase, domain])

  const running = phase.status === "running"

  const previewRows = useMemo(() => {
    if (phase.status !== "done") return []
    return phase.result.rows.slice(0, 50)
  }, [phase])

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
            to write descriptive, page-aware alt text. Output is a CSV with the
            page URL, the image URL, and the suggested alt text — ready for the
            content team to apply.
          </>
        }
      />

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
              disabled={running}
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
              disabled={running}
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
              disabled={running}
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
                alt. Images with existing alt still appear in the CSV (current
                alt preserved, suggested alt blank).
              </span>
            </span>
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={handleRun} disabled={running || !domain.trim()}>
            {running ? "Crawling…" : "Generate alt tags"}
          </Button>
          {running ? (
            <span className="text-xs text-muted-foreground">
              This can take several minutes on larger sites.
            </span>
          ) : null}
        </div>
      </section>

      {phase.status === "error" ? (
        <p
          className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
          role="alert"
        >
          {phase.message}
        </p>
      ) : null}

      {phase.status === "done" ? (
        <ResultPanel
          result={phase.result}
          previewRows={previewRows}
          onDownload={handleDownload}
        />
      ) : null}
    </div>
  )
}

function ResultPanel({
  result,
  previewRows,
  onDownload,
}: {
  result: ApiResult
  previewRows: AltTagRow[]
  onDownload: () => void
}) {
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
        <Button onClick={onDownload}>
          <DownloadIcon /> Download CSV ({result.rows.length} rows)
        </Button>
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
