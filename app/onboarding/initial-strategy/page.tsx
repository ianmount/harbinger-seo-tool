"use client"

import { useCallback, useMemo, useState } from "react"
import { DownloadIcon } from "lucide-react"
import { PageHeader } from "@/components/PageHeader"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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

type Phase =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; result: InitialStrategyOutput }
  | { status: "error"; message: string }

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

export default function InitialStrategyPage() {
  const { partner, loading: partnerLoading, error: partnerError } =
    useSelectedPartner()
  const [sitemapText, setSitemapText] = useState("")
  const [keywordsText, setKeywordsText] = useState("")
  const [phase, setPhase] = useState<Phase>({ status: "idle" })
  const [downloading, setDownloading] = useState(false)

  const canRun =
    !!partner &&
    sitemapText.trim().length > 0 &&
    keywordsText.trim().length > 0 &&
    phase.status !== "running"

  const sitemapStats = useMemo(() => {
    // Cheap pre-flight: count non-blank, non-comment lines.
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
    setPhase({ status: "running" })
    try {
      const response = await fetch("/api/onboarding/initial-strategy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          partnerId: partner.id,
          sitemapText,
          keywordsText,
        }),
      })
      const body = (await response.json().catch(() => ({}))) as {
        result?: InitialStrategyOutput
        error?: string
      }
      if (!response.ok || !body.result) {
        throw new Error(body.error ?? `Request failed (${response.status})`)
      }
      setPhase({ status: "done", result: body.result })
    } catch (err) {
      setPhase({
        status: "error",
        message: err instanceof Error ? err.message : "Failed to run workflow",
      })
    }
  }, [partner, sitemapText, keywordsText])

  const handleDownload = useCallback(async () => {
    if (phase.status !== "done") return
    setDownloading(true)
    try {
      const [{ buildInitialStrategyWorkbook, workbookToArrayBuffer }] =
        await Promise.all([import("@/lib/xlsx-export")])
      const wb = buildInitialStrategyWorkbook(phase.result)
      const buf = await workbookToArrayBuffer(wb)
      const blob = new Blob([buf], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      const stamp = new Date().toISOString().slice(0, 10)
      const slug = slugify(phase.result.partnerName) || "partner"
      a.href = url
      a.download = `${slug}-initial-strategy-${stamp}.xlsx`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } finally {
      setDownloading(false)
    }
  }, [phase])

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
      ) : !partner ? (
        <p className="text-sm text-muted-foreground">
          Please select a partner from the dropdown above.
        </p>
      ) : (
        <>
          <PartnerSummary partner={partner} />

          <section className="space-y-3 rounded-lg border p-4">
            <Label htmlFor="sitemap">Approved new-site sitemap (indented)</Label>
            <Textarea
              id="sitemap"
              placeholder={SITEMAP_PLACEHOLDER}
              value={sitemapText}
              onChange={(e) => setSitemapText(e.target.value)}
              className="min-h-[180px] font-mono text-xs"
              disabled={phase.status === "running"}
            />
            <p className="text-xs text-muted-foreground">
              One page per line. Indent with tabs or 2/4 spaces to nest. Top-level
              page named &ldquo;Home&rdquo; maps to{" "}
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
              disabled={phase.status === "running"}
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
              {phase.status === "running"
                ? "Generating strategy…"
                : "Generate Initial Strategy"}
            </Button>
            {phase.status === "running" ? (
              <span className="text-xs text-muted-foreground" aria-live="polite">
                Crawling current site, parsing inputs, and calling Claude. This
                usually takes 1–3 minutes for a small site.
              </span>
            ) : null}
          </div>

          {phase.status === "error" ? (
            <p
              className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
              role="alert"
            >
              {phase.message}
            </p>
          ) : null}

          {phase.status === "done" ? (
            <ResultView
              result={phase.result}
              onDownload={handleDownload}
              downloading={downloading}
            />
          ) : null}
        </>
      )}
    </div>
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
