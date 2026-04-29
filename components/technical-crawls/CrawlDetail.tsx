"use client"

import { useEffect, useState } from "react"
import { Download, ExternalLink } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { TechnicalIssuePages } from "@/lib/technical-crawl"
import type { CrawlRunFull } from "./types"

/**
 * Issue tile keys correspond to fields on TechnicalIssuePages plus a pair
 * of derived ones ("non_ok") that pull from indexability. Used to decide
 * which list to render in the reveal panel after a tile click.
 */
type IssueKey =
  | "missing_titles"
  | "missing_descriptions"
  | "missing_canonicals"
  | "duplicate_titles"
  | "duplicate_descriptions"
  | "thin_content"
  | "spa_shell"
  | "non_ok"

function formatDate(iso: string | null): string {
  if (!iso) return "—"
  return new Date(iso).toLocaleString()
}

function formatScore(n: number | null): string {
  return typeof n === "number" ? String(n) : "—"
}

function scoreBadgeVariant(score: number | null): "default" | "secondary" | "destructive" {
  if (typeof score !== "number") return "secondary"
  if (score >= 90) return "default"
  if (score >= 50) return "secondary"
  return "destructive"
}

// ── CSV export ─────────────────────────────────────────────────────────────

function csvEscape(value: unknown): string {
  if (value == null) return ""
  const str = String(value)
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`
  return str
}

function buildCsv(run: CrawlRunFull): string {
  const lines: string[] = []
  const push = (cells: unknown[]) => lines.push(cells.map(csvEscape).join(","))

  // Section 1 — run metadata + summary stats. One row per metric so it's
  // pivot-friendly in Excel.
  push(["section", "metric", "value"])
  push(["meta", "domain", run.domain])
  push(["meta", "partner", run.partner_name ?? ""])
  push(["meta", "started_at", run.started_at])
  push(["meta", "finished_at", run.finished_at ?? ""])
  push(["meta", "duration_seconds", run.duration_seconds ?? ""])
  push(["meta", "cost_usd", run.cost_usd ?? ""])
  push(["meta", "source", run.source])
  push(["meta", "status", run.status])

  if (run.summary) {
    for (const [k, v] of Object.entries(run.summary)) {
      if (typeof v === "object" && v !== null) {
        push(["summary", k, JSON.stringify(v)])
      } else {
        push(["summary", k, v ?? ""])
      }
    }
  }

  if (run.lighthouse) {
    push(["lighthouse_aggregate", "averageMobileScore", run.lighthouse.averageMobileScore ?? ""])
    push(["lighthouse_aggregate", "homepageMobileScore", run.lighthouse.homepageMobileScore ?? ""])
    if (run.lighthouse.skippedReason) {
      push(["lighthouse_aggregate", "skippedReason", run.lighthouse.skippedReason])
    }
  }

  // Section 2 — Lighthouse per URL.
  lines.push("")
  push(["lighthouse_url", "performanceScore", "lcp_ms", "inp_ms", "cls", "ttfb_ms"])
  for (const p of run.lighthouse?.pages ?? []) {
    push([p.url, p.performanceScore ?? "", p.lcpMs ?? "", p.inpMs ?? "", p.cls ?? "", p.ttfbMs ?? ""])
  }

  // Section 3 — schema coverage matrix.
  lines.push("")
  push(["schema_page_type", "page_count", "types_found", "types_missing", "pages_with_no_schema"])
  for (const b of run.schema_coverage?.buckets ?? []) {
    push([
      b.pageType,
      b.pageCount,
      b.typesFound.join("|"),
      b.typesMissing.join("|"),
      b.pagesWithNoSchema,
    ])
  }

  // Section 4 — sample pages flattened to one row per (page, issue). Pages
  // with no issues still emit one row so they show up in the export.
  lines.push("")
  push([
    "url",
    "status",
    "title",
    "meta_description",
    "canonical",
    "word_count",
    "images_total",
    "images_with_alt",
    "load_time_ms",
    "redirect_hops",
    "schema_types",
    "issue_code",
    "issue_message",
  ])
  for (const p of run.sample_pages ?? []) {
    const base = [
      p.url,
      p.status,
      p.title ?? "",
      p.metaDescription ?? "",
      p.canonical ?? "",
      p.wordCount,
      p.imagesTotal,
      p.imagesWithAlt,
      p.loadTimeMs,
      Math.max(0, p.redirectChain.length - 1),
      p.schemaTypes.join("|"),
    ]
    if (p.issues.length === 0) {
      push([...base, "", ""])
    } else {
      for (const issue of p.issues) {
        push([...base, issue.code, issue.message])
      }
    }
  }

  // Section 5 — non-OK pages (indexability tail).
  if (run.indexability?.nonOkPages?.length) {
    lines.push("")
    push(["non_ok_url", "status"])
    for (const p of run.indexability.nonOkPages) {
      push([p.url, p.status])
    }
  }

  // Section 6 — full per-issue URL lists. One row per (issue_code, url) so
  // the reader can filter by code in Excel and get every affected URL,
  // not just the ones that made it into the 16-page sample.
  const issuePages = run.issue_pages
  if (issuePages) {
    lines.push("")
    push(["issue_code", "url", "extra"])
    for (const url of issuePages.missingTitles ?? []) push(["missing_title", url, ""])
    for (const url of issuePages.missingDescriptions ?? [])
      push(["missing_description", url, ""])
    for (const url of issuePages.missingCanonicals ?? [])
      push(["missing_canonical", url, ""])
    for (const url of issuePages.spaShell ?? []) push(["spa_shell", url, ""])
    for (const p of issuePages.thinContent ?? [])
      push(["thin_content", p.url, `wordCount=${p.wordCount}`])
    for (const p of issuePages.nonOk ?? [])
      push(["non_ok", p.url, `status=${p.status}`])
    // Duplicate groups: one row per URL in each group, with the shared title/desc
    // in the "extra" column so the reader can see what the duplicates share.
    for (const g of issuePages.duplicateTitles ?? []) {
      for (const url of g.urls) push(["duplicate_title", url, `title=${g.title}`])
    }
    for (const g of issuePages.duplicateDescriptions ?? []) {
      for (const url of g.urls)
        push(["duplicate_description", url, `description=${g.description}`])
    }
  }

  return lines.join("\n")
}

function downloadCsv(run: CrawlRunFull): void {
  const csv = buildCsv(run)
  // Prepend BOM so Excel treats UTF-8 correctly on Windows.
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" })
  const datePart = run.started_at.slice(0, 10)
  const slug = (run.partner_name ?? run.domain).toLowerCase().replace(/[^a-z0-9]+/g, "-")
  const filename = `technical-crawl-${slug}-${datePart}.csv`
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/**
 * Detail view for one crawl. Lazy-loads the heavy JSONB payload from
 * /runs/[id] so the History list payload stays small. Designed to render
 * even when sub-sections are missing — e.g. if Lighthouse was skipped, we
 * still render the technical-issue cards.
 */
export function CrawlDetail({ runId }: { runId: string }) {
  const [run, setRun] = useState<CrawlRunFull | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [openIssue, setOpenIssue] = useState<IssueKey | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setRun(null)
    setOpenIssue(null)
    async function load() {
      try {
        const res = await fetch(`/api/technical-crawls/runs/${runId}`)
        const body = (await res.json()) as { run?: CrawlRunFull; error?: string }
        if (!res.ok || !body.run) {
          throw new Error(body.error ?? `HTTP ${res.status}`)
        }
        if (!cancelled) setRun(body.run)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load crawl")
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [runId])

  if (loading) return <p className="text-sm text-muted-foreground">Loading crawl…</p>
  if (error)
    return (
      <p className="text-sm text-destructive" role="alert">
        {error}
      </p>
    )
  if (!run) return null

  const summary = run.summary
  const lh = run.lighthouse
  const idx = run.indexability
  const schema = run.schema_coverage
  const samples = run.sample_pages ?? []

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="font-sans text-xl font-extrabold tracking-tight">
            {run.partner_name ?? run.domain}
          </h2>
          <Badge variant={run.status === "done" ? "secondary" : run.status === "running" ? "default" : "destructive"}>
            {run.status}
          </Badge>
          <Badge variant="outline">{run.source}</Badge>
          {run.status === "done" ? (
            <Button
              size="sm"
              variant="outline"
              className="ml-auto gap-2"
              onClick={() => downloadCsv(run)}
            >
              <Download className="h-4 w-4" />
              Download CSV
            </Button>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">
          {run.domain} · started {formatDate(run.started_at)} · finished{" "}
          {formatDate(run.finished_at)} · duration{" "}
          {run.duration_seconds ? `${run.duration_seconds}s` : "—"} · cost{" "}
          {typeof run.cost_usd === "number" ? `$${run.cost_usd.toFixed(4)}` : "—"}
        </p>
      </header>

      {run.errors && run.errors.length > 0 ? (
        <section className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-700 dark:bg-amber-950/30">
          <p className="font-medium">Non-fatal errors during this run:</p>
          <ul className="mt-2 list-disc pl-5 text-muted-foreground">
            {run.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {summary ? (
        <section className="space-y-3">
          <h3 className="font-sans text-sm font-extrabold uppercase tracking-[0.18em] text-muted-foreground">
            Summary
          </h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Pages crawled" value={summary.totalPages} />
            <Stat label="OK pages" value={summary.okPages} />
            <Stat
              label="Non-OK pages"
              value={summary.nonOkPages}
              tone={summary.nonOkPages > 0 ? "warn" : undefined}
              onClick={
                summary.nonOkPages > 0
                  ? () => setOpenIssue(toggle(openIssue, "non_ok"))
                  : undefined
              }
              active={openIssue === "non_ok"}
            />
            <Stat
              label="Image alt coverage (sampled)"
              value={`${summary.imageAltCoveragePercent}%`}
              tone={summary.imageAltCoveragePercent < 80 ? "warn" : undefined}
            />
            <Stat
              label="Missing titles"
              value={summary.missingTitles}
              tone={summary.missingTitles > 0 ? "warn" : undefined}
              onClick={
                summary.missingTitles > 0
                  ? () => setOpenIssue(toggle(openIssue, "missing_titles"))
                  : undefined
              }
              active={openIssue === "missing_titles"}
            />
            <Stat
              label="Missing descriptions"
              value={summary.missingDescriptions}
              tone={summary.missingDescriptions > 0 ? "warn" : undefined}
              onClick={
                summary.missingDescriptions > 0
                  ? () => setOpenIssue(toggle(openIssue, "missing_descriptions"))
                  : undefined
              }
              active={openIssue === "missing_descriptions"}
            />
            <Stat
              label="Missing canonicals"
              value={summary.missingCanonicals}
              tone={summary.missingCanonicals > 0 ? "warn" : undefined}
              onClick={
                summary.missingCanonicals > 0
                  ? () => setOpenIssue(toggle(openIssue, "missing_canonicals"))
                  : undefined
              }
              active={openIssue === "missing_canonicals"}
            />
            <Stat
              label="Duplicate title groups"
              value={summary.duplicateTitleGroups}
              tone={summary.duplicateTitleGroups > 0 ? "warn" : undefined}
              onClick={
                summary.duplicateTitleGroups > 0
                  ? () => setOpenIssue(toggle(openIssue, "duplicate_titles"))
                  : undefined
              }
              active={openIssue === "duplicate_titles"}
            />
            <Stat
              label="Duplicate desc. groups"
              value={summary.duplicateDescriptionGroups}
              tone={summary.duplicateDescriptionGroups > 0 ? "warn" : undefined}
              onClick={
                summary.duplicateDescriptionGroups > 0
                  ? () => setOpenIssue(toggle(openIssue, "duplicate_descriptions"))
                  : undefined
              }
              active={openIssue === "duplicate_descriptions"}
            />
            <Stat
              label="Thin content pages"
              value={summary.thinContentPages}
              tone={summary.thinContentPages > 0 ? "warn" : undefined}
              onClick={
                summary.thinContentPages > 0
                  ? () => setOpenIssue(toggle(openIssue, "thin_content"))
                  : undefined
              }
              active={openIssue === "thin_content"}
            />
            <Stat
              label="SPA shell pages"
              value={summary.spaShellPages}
              tone={summary.spaShellPages > 0 ? "warn" : undefined}
              onClick={
                summary.spaShellPages > 0
                  ? () => setOpenIssue(toggle(openIssue, "spa_shell"))
                  : undefined
              }
              active={openIssue === "spa_shell"}
            />
            <Stat label="Sitemap URLs" value={summary.sitemapSize} />
          </div>

          {openIssue ? (
            <IssueRevealPanel
              issueKey={openIssue}
              issuePages={run.issue_pages}
              indexability={run.indexability}
              onClose={() => setOpenIssue(null)}
            />
          ) : null}
        </section>
      ) : null}

      {lh ? (
        <section className="space-y-3">
          <h3 className="font-sans text-sm font-extrabold uppercase tracking-[0.18em] text-muted-foreground">
            Mobile Lighthouse
          </h3>
          {lh.skippedReason ? (
            <p className="text-sm text-muted-foreground">{lh.skippedReason}</p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Stat
                  label="Average score"
                  value={formatScore(lh.averageMobileScore)}
                  tone={
                    typeof lh.averageMobileScore === "number" && lh.averageMobileScore < 50
                      ? "warn"
                      : undefined
                  }
                />
                <Stat
                  label="Homepage score"
                  value={formatScore(lh.homepageMobileScore)}
                  tone={
                    typeof lh.homepageMobileScore === "number" && lh.homepageMobileScore < 50
                      ? "warn"
                      : undefined
                  }
                />
                <Stat label="Pages audited" value={lh.pages.length} />
              </div>
              {lh.pages.length > 0 ? (
                <div className="overflow-hidden rounded-md border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>URL</TableHead>
                        <TableHead className="text-right">Score</TableHead>
                        <TableHead className="text-right">LCP</TableHead>
                        <TableHead className="text-right">INP</TableHead>
                        <TableHead className="text-right">CLS</TableHead>
                        <TableHead className="text-right">TTFB</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {lh.pages.map((p) => (
                        <TableRow key={p.url}>
                          <TableCell className="max-w-[24ch] truncate text-xs" title={p.url}>
                            {p.url}
                          </TableCell>
                          <TableCell className="text-right">
                            <Badge variant={scoreBadgeVariant(p.performanceScore)}>
                              {formatScore(p.performanceScore)}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {p.lcpMs != null ? `${p.lcpMs}ms` : "—"}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {p.inpMs != null ? `${p.inpMs}ms` : "—"}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {p.cls != null ? p.cls.toFixed(3) : "—"}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {p.ttfbMs != null ? `${p.ttfbMs}ms` : "—"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : null}
            </>
          )}
        </section>
      ) : null}

      {schema && schema.buckets.length > 0 ? (
        <section className="space-y-3">
          <h3 className="font-sans text-sm font-extrabold uppercase tracking-[0.18em] text-muted-foreground">
            Schema coverage
          </h3>
          <div className="overflow-hidden rounded-md border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Page type</TableHead>
                  <TableHead className="text-right">Pages</TableHead>
                  <TableHead>Deployment depth (sampled / bucket)</TableHead>
                  <TableHead>Missing entirely</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {schema.buckets.map((b) => {
                  const cov = b.expectedTypeCoverage ?? {}
                  return (
                    <TableRow key={b.pageType}>
                      <TableCell className="font-medium capitalize">
                        {b.pageType}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {b.pageCount}
                      </TableCell>
                      <TableCell className="text-xs">
                        {b.typesExpected.length === 0 ? (
                          "—"
                        ) : (
                          <ul className="space-y-0.5">
                            {b.typesExpected.map((t) => {
                              const found = cov[t] ?? 0
                              const total = b.pageCount
                              const ratio =
                                total === 0 ? 0 : found / total
                              const tone =
                                total === 0
                                  ? "text-muted-foreground"
                                  : ratio === 1
                                    ? "text-foreground"
                                    : ratio === 0
                                      ? "text-destructive"
                                      : "text-amber-600 dark:text-amber-400"
                              return (
                                <li key={t} className={tone}>
                                  <span className="font-medium">{t}</span>:{" "}
                                  {found} / {total}
                                  {total > 0
                                    ? ` (${Math.round(ratio * 100)}%)`
                                    : ""}
                                </li>
                              )
                            })}
                          </ul>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        {b.typesMissing.length === 0 ? (
                          <span className="text-muted-foreground">none</span>
                        ) : (
                          <span className="text-destructive">
                            {b.typesMissing.join(", ")}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
          <p className="text-xs text-muted-foreground">
            Deployment depth = sampled pages in the bucket carrying the type
            (or an accepted alias, e.g. <code>Plumber</code> counts toward{" "}
            <code>LocalBusiness</code>). Schema is sample-based — only ~50
            representative pages have JSON-LD extracted per crawl, so
            denominators reflect the sample, not every crawled page in the
            bucket.
          </p>
        </section>
      ) : null}

      {idx ? (
        <section className="space-y-3">
          <h3 className="font-sans text-sm font-extrabold uppercase tracking-[0.18em] text-muted-foreground">
            Indexability &amp; redirects
          </h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat
              label="Pages that redirect"
              value={idx.redirectingPages}
              tone={idx.redirectingPages > 0 ? "warn" : undefined}
            />
            <Stat
              label="Long redirect chains (>2 hops)"
              value={idx.longRedirectChains}
              tone={idx.longRedirectChains > 0 ? "warn" : undefined}
            />
            <Stat
              label="Missing canonicals"
              value={idx.missingCanonicals}
              tone={idx.missingCanonicals > 0 ? "warn" : undefined}
            />
          </div>
          {idx.nonOkPages.length > 0 ? (
            <div className="overflow-hidden rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Non-OK URL</TableHead>
                    <TableHead className="w-24 text-right">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {idx.nonOkPages.map((p) => (
                    <TableRow key={p.url}>
                      <TableCell className="max-w-[60ch] truncate text-xs" title={p.url}>
                        {p.url}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {p.status || "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}
        </section>
      ) : null}

      {samples.length > 0 ? (
        <section className="space-y-3">
          <h3 className="font-sans text-sm font-extrabold uppercase tracking-[0.18em] text-muted-foreground">
            Sample pages with issues
          </h3>
          <div className="overflow-hidden rounded-md border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>URL</TableHead>
                  <TableHead className="text-right">Status</TableHead>
                  <TableHead className="text-right">Words</TableHead>
                  <TableHead>Issues</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {samples.map((p) => (
                  <TableRow key={p.url}>
                    <TableCell className="max-w-[36ch] truncate text-xs" title={p.url}>
                      {p.url}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{p.status}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {p.wordCount}
                    </TableCell>
                    <TableCell className="text-xs">
                      {p.issues.length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <ul className="list-disc pl-4">
                          {p.issues.map((i) => (
                            <li key={i.code}>{i.message}</li>
                          ))}
                        </ul>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      ) : null}
    </div>
  )
}

function toggle(current: IssueKey | null, next: IssueKey): IssueKey | null {
  return current === next ? null : next
}

const ISSUE_LABELS: Record<IssueKey, string> = {
  missing_titles: "Missing titles",
  missing_descriptions: "Missing descriptions",
  missing_canonicals: "Missing canonicals",
  duplicate_titles: "Duplicate title groups",
  duplicate_descriptions: "Duplicate description groups",
  thin_content: "Thin content pages",
  spa_shell: "SPA shell pages",
  non_ok: "Non-OK pages",
}

function IssueRevealPanel({
  issueKey,
  issuePages,
  indexability,
  onClose,
}: {
  issueKey: IssueKey
  issuePages: TechnicalIssuePages | null
  indexability: CrawlRunFull["indexability"]
  onClose: () => void
}) {
  const label = ISSUE_LABELS[issueKey]
  const truncation = issuePages?.truncated as
    | Partial<Record<string, { actual: number; shown: number }>>
    | undefined

  // Most issue lists come from issuePages; non_ok also exists in the older
  // indexability column, so we fall back to that for runs persisted before
  // issue_pages was added.
  const truncationMeta =
    issueKey === "missing_titles"
      ? truncation?.missingTitles
      : issueKey === "missing_descriptions"
        ? truncation?.missingDescriptions
        : issueKey === "missing_canonicals"
          ? truncation?.missingCanonicals
          : issueKey === "duplicate_titles"
            ? truncation?.duplicateTitles
            : issueKey === "duplicate_descriptions"
              ? truncation?.duplicateDescriptions
              : issueKey === "thin_content"
                ? truncation?.thinContent
                : issueKey === "spa_shell"
                  ? truncation?.spaShell
                  : issueKey === "non_ok"
                    ? truncation?.nonOk
                    : undefined

  let body: React.ReactNode

  switch (issueKey) {
    case "missing_titles":
    case "missing_descriptions":
    case "missing_canonicals":
    case "spa_shell": {
      const list =
        issueKey === "missing_titles"
          ? issuePages?.missingTitles ?? []
          : issueKey === "missing_descriptions"
            ? issuePages?.missingDescriptions ?? []
            : issueKey === "missing_canonicals"
              ? issuePages?.missingCanonicals ?? []
              : issuePages?.spaShell ?? []
      body = <UrlList urls={list} />
      break
    }
    case "thin_content": {
      const list = issuePages?.thinContent ?? []
      body = (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>URL</TableHead>
              <TableHead className="w-24 text-right">Words</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((p) => (
              <TableRow key={p.url}>
                <TableCell className="break-all text-xs">
                  <UrlLink url={p.url} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {p.wordCount}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )
      break
    }
    case "non_ok": {
      const list =
        issuePages?.nonOk && issuePages.nonOk.length > 0
          ? issuePages.nonOk
          : indexability?.nonOkPages ?? []
      body = (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>URL</TableHead>
              <TableHead className="w-24 text-right">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((p) => (
              <TableRow key={p.url}>
                <TableCell className="break-all text-xs">
                  <UrlLink url={p.url} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {p.status || "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )
      break
    }
    case "duplicate_titles":
    case "duplicate_descriptions": {
      const groups =
        issueKey === "duplicate_titles"
          ? (issuePages?.duplicateTitles ?? []).map((g) => ({
              shared: g.title,
              urls: g.urls,
            }))
          : (issuePages?.duplicateDescriptions ?? []).map((g) => ({
              shared: g.description,
              urls: g.urls,
            }))
      body = (
        <ul className="space-y-3">
          {groups.map((g, i) => (
            <li key={i} className="rounded-md border border-border bg-card/50 p-3">
              <p className="break-words text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Shared value:</span>{" "}
                {g.shared || <em>(empty)</em>}
              </p>
              <ul className="mt-2 space-y-0.5 text-xs">
                {g.urls.map((u) => (
                  <li key={u} className="break-all">
                    <UrlLink url={u} />
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )
      break
    }
  }

  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="font-sans text-sm font-extrabold uppercase tracking-[0.14em]">
            {label}
          </p>
          {truncationMeta ? (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
              Showing {truncationMeta.shown} of {truncationMeta.actual} — list was
              capped at {truncationMeta.shown} URLs.
            </p>
          ) : null}
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      {body}
    </div>
  )
}

function UrlList({ urls }: { urls: string[] }) {
  if (urls.length === 0) {
    return <p className="text-sm text-muted-foreground">No URLs to show.</p>
  }
  return (
    <ul className="space-y-0.5 text-xs">
      {urls.map((u) => (
        <li key={u} className="break-all">
          <UrlLink url={u} />
        </li>
      ))}
    </ul>
  )
}

function UrlLink({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-baseline gap-1 hover:underline"
    >
      <span>{url}</span>
      <ExternalLink className="h-3 w-3 self-center text-muted-foreground" />
    </a>
  )
}

function Stat({
  label,
  value,
  tone,
  onClick,
  active,
}: {
  label: string
  value: number | string
  tone?: "warn"
  onClick?: () => void
  active?: boolean
}) {
  const interactive = typeof onClick === "function"
  const base =
    "block w-full rounded-md border p-3 text-left transition-colors"
  const toneClass =
    tone === "warn"
      ? "border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30"
      : "border-border bg-card"
  const activeClass = active
    ? " ring-2 ring-foreground/40"
    : interactive
      ? " hover:border-foreground/40 hover:bg-accent/50 cursor-pointer"
      : ""

  const content = (
    <>
      <p className="text-xs uppercase tracking-wider text-muted-foreground">
        {label}
        {interactive ? (
          <span className="ml-1 text-[10px] normal-case text-muted-foreground/60">
            (click to view)
          </span>
        ) : null}
      </p>
      <p className="mt-1 font-sans text-2xl font-extrabold tabular-nums">{value}</p>
    </>
  )

  if (interactive) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`${base} ${toneClass}${activeClass}`}
      >
        {content}
      </button>
    )
  }
  return <div className={`${base} ${toneClass}`}>{content}</div>
}
