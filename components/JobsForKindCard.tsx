"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { Ban, CheckCircle2, Loader2, X, XCircle } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { cn } from "@/lib/utils"

/**
 * Per-kind background jobs card.
 *
 * Drop-in component for any task page (Audit, Comp Analysis, Initial
 * Strategy, Technical Crawl, Alt Tags). Lists recent jobs of the given
 * `kind` for the current session, with live progress for in-flight ones.
 *
 * Polling cadence matches the header JobsTray: 3s while anything is
 * active, 30s otherwise. Dismissed job IDs live in localStorage so they
 * stay hidden across navigations within the same session.
 */

type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
export type JobKind =
  | "audit"
  | "comp_analysis"
  | "initial_strategy"
  | "technical_crawl"
  | "alt_tags"
  | "full_audit"

interface Job {
  id: string
  kind: JobKind
  status: JobStatus
  title: string
  result_path: string | null
  progress: { stage?: string; detail?: string; percent?: number | null }
  error: string | null
  created_at: string
}

const ACTIVE_POLL_MS = 3000
const IDLE_POLL_MS = 30000
const DISMISSED_KEY = "harbinger:dismissed_jobs"

function readDismissed(): Set<string> {
  if (typeof window === "undefined") return new Set()
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((s): s is string => typeof s === "string"))
  } catch {
    return new Set()
  }
}

function writeDismissed(ids: Set<string>): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(
      DISMISSED_KEY,
      JSON.stringify(Array.from(ids)),
    )
  } catch {
    /* ignore quota errors */
  }
}

interface Props {
  kind: JobKind
  /** Heading rendered on the card. Defaults to "Recent runs". */
  title?: string
  /** Cap how many jobs render. Defaults to 10. */
  limit?: number
  className?: string
}

export function JobsForKindCard({
  kind,
  title = "Recent runs",
  limit = 10,
  className,
}: Props) {
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [dismissed, setDismissed] = useState<Set<string>>(() => readDismissed())

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/jobs", { cache: "no-store" })
      if (!res.ok) return
      const body = (await res.json()) as { jobs: Job[] }
      setJobs(body.jobs ?? [])
    } catch {
      /* swallow — next tick retries */
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = async () => {
      if (cancelled) return
      await fetchJobs()
      if (cancelled) return
      const hasActive = (jobs ?? []).some(
        (j) =>
          j.kind === kind && (j.status === "queued" || j.status === "running"),
      )
      const delay = hasActive ? ACTIVE_POLL_MS : IDLE_POLL_MS
      timer = setTimeout(tick, delay)
    }

    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchJobs, kind])

  const visible = useMemo(() => {
    return (jobs ?? [])
      .filter((j) => j.kind === kind && !dismissed.has(j.id))
      .slice(0, limit)
  }, [jobs, kind, dismissed, limit])

  const clearableCount = useMemo(
    () =>
      visible.filter(
        (j) =>
          j.status === "completed" ||
          j.status === "failed" ||
          j.status === "cancelled",
      ).length,
    [visible],
  )

  const dismissOne = useCallback((id: string) => {
    setDismissed((prev) => {
      const next = new Set(prev)
      next.add(id)
      writeDismissed(next)
      return next
    })
  }, [])

  const clearAllCompleted = useCallback(() => {
    const idsToHide = visible
      .filter(
        (j) =>
          j.status === "completed" ||
          j.status === "failed" ||
          j.status === "cancelled",
      )
      .map((j) => j.id)
    if (idsToHide.length === 0) return
    setDismissed((prev) => {
      const next = new Set(prev)
      for (const id of idsToHide) next.add(id)
      writeDismissed(next)
      return next
    })
  }, [visible])

  if (jobs === null) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="text-base">{title}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Loading…
        </CardContent>
      </Card>
    )
  }

  if (visible.length === 0) return null

  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="text-base">{title}</CardTitle>
        {clearableCount > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={clearAllCompleted}
          >
            Clear {clearableCount === 1 ? "" : "all "}
            ({clearableCount})
          </Button>
        )}
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y">
          {visible.map((job) => (
            <li key={job.id} className="px-6 py-3">
              <JobRow job={job} onDismiss={() => dismissOne(job.id)} />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

function JobRow({
  job,
  onDismiss,
}: {
  job: Job
  onDismiss: () => void
}) {
  const href = job.result_path ?? `/jobs/${job.id}`
  const active = job.status === "queued" || job.status === "running"
  const terminal =
    job.status === "completed" ||
    job.status === "failed" ||
    job.status === "cancelled"
  return (
    <div className="flex items-start gap-3">
      <StatusIcon status={job.status} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{job.title}</div>
        {active ? (
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {job.progress?.stage
              ? `${job.progress.stage}${job.progress.detail ? ` — ${job.progress.detail}` : ""}`
              : job.status === "queued"
                ? "Queued"
                : "Running…"}
          </div>
        ) : job.status === "failed" ? (
          <div className="mt-0.5 truncate text-xs text-destructive">
            {job.error ?? "Failed"}
          </div>
        ) : job.status === "cancelled" ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            Cancelled {formatRelative(job.created_at)}
          </div>
        ) : (
          <div className="mt-0.5 text-xs text-muted-foreground">
            Completed {formatRelative(job.created_at)}
          </div>
        )}
        <div className="mt-1 flex items-center gap-3">
          {(job.status === "completed" || job.status === "failed") && (
            <Link
              href={href}
              className="text-xs font-bold uppercase tracking-[0.12em] text-primary hover:underline"
            >
              View
            </Link>
          )}
          {active && <CancelButton jobId={job.id} />}
        </div>
      </div>
      {terminal && (
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="-mr-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}

function CancelButton({ jobId }: { jobId: string }) {
  const [busy, setBusy] = useState(false)
  const onClick = async () => {
    if (busy) return
    setBusy(true)
    try {
      const res = await fetch(`/api/jobs/${jobId}/cancel`, { method: "POST" })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        toast.error("Could not cancel", {
          description: body.error ?? `HTTP ${res.status}`,
        })
      } else {
        toast.message("Cancelling…")
      }
    } catch (err) {
      toast.error("Could not cancel", {
        description: err instanceof Error ? err.message : "Network error",
      })
    } finally {
      setBusy(false)
    }
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="text-xs font-bold uppercase tracking-[0.12em] text-destructive hover:underline disabled:opacity-50"
    >
      {busy ? "Cancelling…" : "Cancel"}
    </button>
  )
}

function StatusIcon({ status }: { status: JobStatus }) {
  const className = "mt-0.5 h-4 w-4 shrink-0"
  switch (status) {
    case "queued":
    case "running":
      return (
        <Loader2 className={cn(className, "animate-spin text-primary")} />
      )
    case "completed":
      return <CheckCircle2 className={cn(className, "text-emerald-600")} />
    case "failed":
      return <XCircle className={cn(className, "text-destructive")} />
    case "cancelled":
      return <Ban className={cn(className, "text-muted-foreground")} />
  }
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ""
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (diffSec < 60) return "just now"
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`
  return `${Math.floor(diffSec / 86400)}d ago`
}
