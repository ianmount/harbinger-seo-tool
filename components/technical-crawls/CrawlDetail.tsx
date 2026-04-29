"use client"

import { useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { CrawlRunFull } from "./types"

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

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setRun(null)
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
        <div className="flex items-baseline gap-3">
          <h2 className="font-sans text-xl font-extrabold tracking-tight">
            {run.partner_name ?? run.domain}
          </h2>
          <Badge variant={run.status === "done" ? "secondary" : run.status === "running" ? "default" : "destructive"}>
            {run.status}
          </Badge>
          <Badge variant="outline">{run.source}</Badge>
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
            />
            <Stat
              label="Image alt coverage"
              value={`${summary.imageAltCoveragePercent}%`}
              tone={summary.imageAltCoveragePercent < 80 ? "warn" : undefined}
            />
            <Stat
              label="Missing titles"
              value={summary.missingTitles}
              tone={summary.missingTitles > 0 ? "warn" : undefined}
            />
            <Stat
              label="Missing descriptions"
              value={summary.missingDescriptions}
              tone={summary.missingDescriptions > 0 ? "warn" : undefined}
            />
            <Stat
              label="Missing canonicals"
              value={summary.missingCanonicals}
              tone={summary.missingCanonicals > 0 ? "warn" : undefined}
            />
            <Stat
              label="Duplicate title groups"
              value={summary.duplicateTitleGroups}
              tone={summary.duplicateTitleGroups > 0 ? "warn" : undefined}
            />
            <Stat
              label="Duplicate desc. groups"
              value={summary.duplicateDescriptionGroups}
              tone={summary.duplicateDescriptionGroups > 0 ? "warn" : undefined}
            />
            <Stat
              label="Thin content pages"
              value={summary.thinContentPages}
              tone={summary.thinContentPages > 0 ? "warn" : undefined}
            />
            <Stat
              label="SPA shell pages"
              value={summary.spaShellPages}
              tone={summary.spaShellPages > 0 ? "warn" : undefined}
            />
            <Stat label="Sitemap URLs" value={summary.sitemapSize} />
          </div>
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
                  <TableHead>Types found</TableHead>
                  <TableHead>Missing</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {schema.buckets.map((b) => (
                  <TableRow key={b.pageType}>
                    <TableCell className="font-medium capitalize">
                      {b.pageType}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {b.pageCount}
                    </TableCell>
                    <TableCell className="text-xs">
                      {b.typesFound.length === 0 ? "—" : b.typesFound.join(", ")}
                    </TableCell>
                    <TableCell className="text-xs">
                      {b.typesMissing.length === 0 ? (
                        <span className="text-muted-foreground">complete</span>
                      ) : (
                        <span className="text-destructive">
                          {b.typesMissing.join(", ")}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
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

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: number | string
  tone?: "warn"
}) {
  return (
    <div
      className={`rounded-md border p-3 ${
        tone === "warn"
          ? "border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30"
          : "border-border bg-card"
      }`}
    >
      <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 font-sans text-2xl font-extrabold tabular-nums">{value}</p>
    </div>
  )
}
