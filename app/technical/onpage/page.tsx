"use client"

import { useState, type FormEvent } from "react"
import {
  AlertCircle,
  AlertTriangle,
  Check,
  Info,
  Loader2,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ToolShell } from "@/components/tool/ToolShell"
import { ToolError, useToolRun } from "@/components/tool/use-tool-run"
import { findToolByPathname } from "@/lib/tool-config"
import type {
  AuditReport,
  Category,
  CategoryBucket,
  IssueSeverity,
  PerUrlRow,
  SchemaRow,
  TopIssue,
} from "@/lib/onpage-audit"
import { cn } from "@/lib/utils"

// ── Helpers ────────────────────────────────────────────────────────────────

function severityColor(sev: IssueSeverity): string {
  if (sev === "error") return "text-danger"
  if (sev === "warning") return "text-warning"
  return "text-info"
}

function SeverityIcon({ sev }: { sev: IssueSeverity }) {
  if (sev === "error") return <AlertCircle className={cn("h-4 w-4", severityColor(sev))} aria-label="Error" />
  if (sev === "warning") return <AlertTriangle className={cn("h-4 w-4", severityColor(sev))} aria-label="Warning" />
  return <Info className={cn("h-4 w-4", severityColor(sev))} aria-label="Notice" />
}

function categoryColor(cat: Category): string {
  switch (cat) {
    case "Crawlability":
    case "HTTPS":
    case "Indexation":
      return "#c31b00"
    case "On-page SEO":
    case "Performance":
    case "Internal linking":
    case "Schema":
    default:
      return "#c77c00"
  }
}

function formatMs(ms: number | null): string {
  if (ms == null) return "—"
  return `${(ms / 1000).toFixed(1)}s`
}

function formatLcp(ms: number | null): string {
  if (ms == null) return "—"
  return `${(ms / 1000).toFixed(1)}s`
}

function formatInp(ms: number | null): string {
  if (ms == null) return "—"
  return `${Math.round(ms)}ms`
}

function formatCls(cls: number | null): string {
  if (cls == null) return "—"
  return cls.toFixed(2)
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })
  } catch {
    return iso
  }
}

// ── Sub-components ─────────────────────────────────────────────────────────

function SectionCard({
  title,
  source,
  children,
  className,
}: {
  title?: string
  source?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "rounded-lg border border-line bg-card p-5",
        className,
      )}
    >
      {title ? (
        <p className="mb-3 font-sans text-[13px] font-semibold uppercase tracking-[0.14em] text-foreground/85">
          {title}
        </p>
      ) : null}
      {children}
      {source ? (
        <p className="mt-3 font-mono text-[10.5px] text-ink-3">{source}</p>
      ) : null}
    </div>
  )
}

function HealthGauge({ score }: { score: number }) {
  // Doughnut as an SVG arc. Radius 80, stroke 16; gives a 192-px square.
  const r = 80
  const stroke = 16
  const circ = 2 * Math.PI * r
  const dash = (score / 100) * circ
  const color =
    score >= 80 ? "#1a8f5a" : score >= 50 ? "#c77c00" : "#c31b00"
  return (
    <div className="relative h-[192px] w-[192px] shrink-0">
      <svg
        viewBox="0 0 192 192"
        className="absolute inset-0 -rotate-90"
        aria-label={`Site health score: ${score} out of 100`}
        role="img"
      >
        <circle
          cx="96"
          cy="96"
          r={r}
          fill="none"
          stroke="var(--color-line)"
          strokeWidth={stroke}
        />
        <circle
          cx="96"
          cy="96"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circ - dash}`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-sans text-[10px] font-bold uppercase tracking-[0.16em] text-ink-3">
          Site health
        </span>
        <span className="mt-1 font-sans text-[44px] font-extrabold leading-none tabular-nums text-foreground">
          {score}
        </span>
        <span className="mt-1 font-serif text-[11px] text-ink-3">
          out of 100
        </span>
      </div>
    </div>
  )
}

function Kpi({
  label,
  value,
  valueClass,
  wide,
}: {
  label: string
  value: string
  valueClass?: string
  wide?: boolean
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-0.5 rounded-md bg-muted px-3.5 py-3",
        wide ? "col-span-2" : "",
      )}
    >
      <span className="font-sans text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-3">
        {label}
      </span>
      <span
        className={cn(
          "font-sans text-[22px] font-extrabold leading-tight tabular-nums",
          valueClass ?? "text-foreground",
        )}
      >
        {value}
      </span>
    </div>
  )
}

function HealthSummary({ data }: { data: AuditReport }) {
  return (
    <SectionCard source="on_page/summary · derived health score from weighted severity rubric">
      <div className="grid items-center gap-6 md:grid-cols-[192px_1fr]">
        <HealthGauge score={data.health} />
        <div className="grid grid-cols-2 gap-2.5">
          <Kpi
            label="Pages crawled"
            value={data.totals.pagesCrawled.toLocaleString()}
          />
          <Kpi
            label="Errors"
            value={data.totals.errors.toLocaleString()}
            valueClass="text-danger"
          />
          <Kpi
            label="Warnings"
            value={data.totals.warnings.toLocaleString()}
            valueClass="text-warning"
          />
          <Kpi
            label="Notices"
            value={data.totals.notices.toLocaleString()}
            valueClass="text-info"
          />
          <div className="col-span-2 flex flex-col gap-0.5 rounded-md bg-muted px-3.5 py-3">
            <span className="font-sans text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-3">
              Last crawl
            </span>
            <span className="font-sans text-[14px] font-semibold tabular-nums text-foreground">
              {formatDate(data.totals.lastCrawlIso)}
              {data.jsRendered ? " · JS rendered" : ""}
            </span>
          </div>
        </div>
      </div>
    </SectionCard>
  )
}

function IssuesByCategory({ buckets }: { buckets: CategoryBucket[] }) {
  if (buckets.length === 0) {
    return (
      <SectionCard
        title="Issues by category"
        source="on_page/summary · checks grouped by category"
      >
        <p className="font-serif text-[13px] italic text-ink-3">
          No issues detected — clean run.
        </p>
      </SectionCard>
    )
  }
  const max = Math.max(...buckets.map((b) => b.count))
  return (
    <SectionCard
      title="Issues by category"
      source="on_page/summary · checks grouped by category"
    >
      <div className="space-y-1.5">
        {buckets.map((b) => (
          <div
            key={b.category}
            className="grid grid-cols-[140px_1fr_36px] items-center gap-2.5 text-[12.5px]"
          >
            <span className="text-ink-2">{b.category}</span>
            <div className="h-2.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.round((b.count / max) * 100)}%`,
                  background: categoryColor(b.category),
                }}
              />
            </div>
            <span className="text-right font-sans font-semibold tabular-nums">
              {b.count}
            </span>
          </div>
        ))}
      </div>
    </SectionCard>
  )
}

function TopIssues({ issues }: { issues: TopIssue[] }) {
  return (
    <SectionCard
      title="Top issues by priority"
      source="on_page/summary · sorted by severity then affected page count"
    >
      {issues.length === 0 ? (
        <p className="font-serif text-[13px] italic text-ink-3">
          No failing checks.
        </p>
      ) : (
        <div className="divide-y divide-line">
          {issues.map((issue) => (
            <div
              key={issue.id}
              className="grid grid-cols-[24px_1fr_auto] items-start gap-3 py-2.5"
            >
              <SeverityIcon sev={issue.severity} />
              <div className="min-w-0">
                <p className="font-sans text-[13px] font-semibold leading-snug text-foreground">
                  {issue.label}
                </p>
                <p className="mt-0.5 font-serif text-[11.5px] text-ink-3">
                  {issue.category} · {issue.rationale}
                </p>
                {issue.sampleUrl ? (
                  <p
                    className="mt-0.5 truncate font-mono text-[10.5px] text-ink-3"
                    title={issue.sampleUrl}
                  >
                    {issue.sampleUrl}
                  </p>
                ) : null}
              </div>
              <span className="whitespace-nowrap font-sans text-[12px] font-semibold tabular-nums text-ink-2">
                {issue.affectedPages.toLocaleString()}{" "}
                {issue.affectedPages === 1 ? "page" : "pages"}
              </span>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  )
}

function PerUrlAudit({ rows }: { rows: PerUrlRow[] }) {
  return (
    <SectionCard
      title="Per-URL audit"
      source="on_page/pages · joined with on_page/duplicate_tags · on_page/redirect_chains · on_page/non_indexable"
    >
      <div className="overflow-x-auto">
        <table className="w-full table-fixed border-collapse">
          <colgroup>
            <col />
            <col className="w-[70px]" />
            <col className="w-[70px]" />
            <col className="w-[120px]" />
            <col className="w-[70px]" />
          </colgroup>
          <thead>
            <tr className="border-b border-line text-left">
              <th className="px-1 py-2 font-sans text-[10.5px] font-bold uppercase tracking-[0.12em] text-ink-3">
                URL
              </th>
              <th className="px-1 py-2 text-right font-sans text-[10.5px] font-bold uppercase tracking-[0.12em] text-ink-3">
                Status
              </th>
              <th className="px-1 py-2 text-right font-sans text-[10.5px] font-bold uppercase tracking-[0.12em] text-ink-3">
                Issues
              </th>
              <th className="px-1 py-2 font-sans text-[10.5px] font-bold uppercase tracking-[0.12em] text-ink-3">
                Title
              </th>
              <th className="px-1 py-2 text-right font-sans text-[10.5px] font-bold uppercase tracking-[0.12em] text-ink-3">
                Load
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-1 py-6 text-center font-serif text-[13px] italic text-ink-3"
                >
                  No pages crawled.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={row.url}
                  className="border-b border-line/60 align-top"
                >
                  <td className="overflow-hidden truncate px-1 py-2 font-mono text-[11px] text-foreground">
                    <span title={row.url}>{row.path}</span>
                  </td>
                  <td
                    className={cn(
                      "px-1 py-2 text-right font-mono text-[11.5px] tabular-nums",
                      row.statusCode >= 400
                        ? "text-danger"
                        : row.statusCode >= 300
                          ? "text-warning"
                          : "text-success",
                    )}
                  >
                    {row.statusCode || "—"}
                  </td>
                  <td
                    className={cn(
                      "px-1 py-2 text-right font-sans text-[12px] font-semibold tabular-nums",
                      row.issues >= 10
                        ? "text-danger"
                        : row.issues >= 4
                          ? "text-warning"
                          : "text-foreground",
                    )}
                  >
                    {row.issues}
                  </td>
                  <td className="px-1 py-2 text-[12px]">
                    <span className="inline-flex items-center gap-1.5">
                      {row.titleStatus === "ok" ? (
                        <Check className="h-3 w-3 shrink-0 text-success" />
                      ) : row.titleStatus === "warn" ? (
                        <AlertTriangle className="h-3 w-3 shrink-0 text-warning" />
                      ) : (
                        <X className="h-3 w-3 shrink-0 text-danger" />
                      )}
                      <span
                        className={cn(
                          "tabular-nums",
                          row.titleStatus === "missing"
                            ? "italic text-ink-3"
                            : "text-foreground",
                        )}
                      >
                        {row.titleStatus === "missing"
                          ? "missing"
                          : `${row.titleLen} chars`}
                      </span>
                    </span>
                  </td>
                  <td
                    className={cn(
                      "px-1 py-2 text-right font-mono text-[11.5px] tabular-nums",
                      row.loadTimeMs == null
                        ? "text-ink-3"
                        : row.loadTimeMs > 4000
                          ? "text-danger"
                          : row.loadTimeMs > 2500
                            ? "text-warning"
                            : "text-success",
                    )}
                  >
                    {formatMs(row.loadTimeMs)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </SectionCard>
  )
}

function CwvCard({ cwv }: { cwv: AuditReport["cwv"] }) {
  if (!cwv) {
    return (
      <SectionCard
        title="Core Web Vitals"
        source="on_page/lighthouse · n/a"
        className="!mb-0"
      >
        <p className="font-serif text-[13px] italic text-ink-3">
          Lighthouse data unavailable.
        </p>
      </SectionCard>
    )
  }
  const sourceLabel =
    cwv.source === "homepage-lighthouse"
      ? `on_page/lighthouse · homepage (${cwv.sourceUrl ?? "n/a"})`
      : "on_page/pages · page_timing median (Lighthouse skipped)"

  const lcpStatus =
    cwv.lcpMs == null
      ? "unknown"
      : cwv.lcpMs <= 2500
        ? "good"
        : cwv.lcpMs <= 4000
          ? "needs-work"
          : "poor"
  const inpStatus =
    cwv.inpMs == null
      ? "unknown"
      : cwv.inpMs <= 200
        ? "good"
        : cwv.inpMs <= 500
          ? "needs-work"
          : "poor"
  const clsStatus =
    cwv.cls == null
      ? "unknown"
      : cwv.cls <= 0.1
        ? "good"
        : cwv.cls <= 0.25
          ? "needs-work"
          : "poor"

  return (
    <SectionCard title="Core Web Vitals" source={sourceLabel} className="!mb-0">
      <div className="flex flex-col gap-2">
        <CwvRow
          label="LCP"
          value={formatLcp(cwv.lcpMs)}
          target="≤ 2.5s"
          status={lcpStatus}
        />
        <CwvRow
          label="INP"
          value={formatInp(cwv.inpMs)}
          target="≤ 200ms"
          status={inpStatus}
        />
        <CwvRow
          label="CLS"
          value={formatCls(cwv.cls)}
          target="≤ 0.1"
          status={clsStatus}
        />
      </div>
    </SectionCard>
  )
}

function CwvRow({
  label,
  value,
  target,
  status,
}: {
  label: string
  value: string
  target: string
  status: "good" | "needs-work" | "poor" | "unknown"
}) {
  const pill =
    status === "good"
      ? {
          label: "Good",
          className: "bg-success-light text-success-dark",
        }
      : status === "needs-work"
        ? {
            label: "Needs work",
            className: "bg-warning-light text-warning-dark",
          }
        : status === "poor"
          ? {
              label: "Poor",
              className: "bg-danger-light text-danger-dark",
            }
          : { label: "—", className: "bg-muted text-ink-3" }
  return (
    <div className="rounded-md bg-muted px-3 py-2.5">
      <div className="flex items-center justify-between">
        <span className="font-sans text-[12.5px] font-semibold text-ink-2">
          {label}
        </span>
        <span
          className={cn(
            "rounded-md px-2 py-0.5 font-sans text-[10.5px] font-semibold uppercase tracking-[0.08em]",
            pill.className,
          )}
        >
          {pill.label}
        </span>
      </div>
      <div className="mt-1 font-sans text-[18px] font-extrabold tabular-nums text-foreground">
        {value}
      </div>
      <div className="font-serif text-[10.5px] text-ink-3">Target {target}</div>
    </div>
  )
}

function SchemaCard({ rows }: { rows: SchemaRow[] }) {
  return (
    <SectionCard
      title="Schema validation"
      source="on_page/microdata · validated against schema.org"
      className="!mb-0"
    >
      <div className="divide-y divide-line">
        {rows.map((row) => (
          <div
            key={row.type}
            className="flex items-center justify-between py-2 text-[12.5px]"
          >
            <div className="flex items-center gap-2">
              {row.status === "ok" ? (
                <Check className="h-4 w-4 text-success" />
              ) : row.status === "partial" ? (
                <AlertTriangle className="h-4 w-4 text-warning" />
              ) : (
                <X className="h-4 w-4 text-danger" />
              )}
              <span className="text-foreground">{row.type}</span>
            </div>
            <span
              className={cn(
                "font-sans tabular-nums",
                row.status === "ok"
                  ? "text-ink-2"
                  : row.status === "partial"
                    ? "text-warning-dark"
                    : "text-danger-dark",
              )}
            >
              {schemaSubtitle(row)}
            </span>
          </div>
        ))}
      </div>
    </SectionCard>
  )
}

function schemaSubtitle(row: SchemaRow): string {
  if (row.status === "missing") {
    return row.expectedOn != null
      ? `missing on ${row.expectedOn}`
      : "not found"
  }
  if (row.status === "partial") {
    return `${row.foundOn} of ${row.expectedOn} expected`
  }
  if (row.expectedOn === row.foundOn && row.expectedOn != null) {
    return `all ${row.foundOn} pages`
  }
  return `${row.foundOn} ${row.foundOn === 1 ? "page" : "pages"}`
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function OnPagePage() {
  const tool = findToolByPathname("/technical/onpage")!
  const [target, setTarget] = useState("")
  const [maxPages, setMaxPages] = useState("50")
  const { data, meta, loading, error, run, setError } =
    useToolRun<AuditReport>("/api/tools/technical/onpage")

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!target.trim()) {
      setError("Enter a target URL.")
      return
    }
    const pages = Number(maxPages)
    if (!Number.isFinite(pages) || pages < 1 || pages > 200) {
      setError("Max pages must be 1–200 for synchronous mode.")
      return
    }
    await run({ target: target.trim(), max_crawl_pages: pages })
  }

  return (
    <ToolShell
      category="Technical"
      title={tool.label}
      description={tool.description}
      endpoints={tool.endpoints}
      meta={meta}
      save={{
        kind: "onpage_audit",
        enabled: data != null,
        getDefaultTitle: () => `${target || "Domain"} — On-page audit`,
        getData: () => ({
          target,
          capturedAt: new Date().toISOString(),
          ...data,
        }),
      }}
      form={
        <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
          <div className="grow space-y-1.5 min-w-[260px]">
            <Label htmlFor="target">Site URL</Label>
            <Input
              id="target"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="https://example.com"
              disabled={loading}
            />
          </div>
          <div className="w-[140px] space-y-1.5">
            <Label htmlFor="max-pages">Max pages</Label>
            <Input
              id="max-pages"
              type="number"
              min={1}
              max={200}
              value={maxPages}
              onChange={(e) => setMaxPages(e.target.value)}
              disabled={loading}
            />
          </div>
          <Button type="submit" disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Run audit
          </Button>
        </form>
      }
      results={
        error ? (
          <ToolError message={error} />
        ) : !data ? null : (
          <div className="space-y-3.5">
            <HealthSummary data={data} />
            <IssuesByCategory buckets={data.byCategory} />
            <TopIssues issues={data.topIssues} />
            <PerUrlAudit rows={data.perUrl} />
            <div className="grid gap-3.5 md:grid-cols-2">
              <CwvCard cwv={data.cwv} />
              <SchemaCard rows={data.schema} />
            </div>
          </div>
        )
      }
    />
  )
}
