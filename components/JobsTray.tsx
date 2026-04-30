"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { Bell, CheckCircle2, Loader2, XCircle } from "lucide-react"
import { toast } from "sonner"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"

/**
 * Header bell that lists this session's background jobs.
 *
 * Polling, not Realtime: while at least one job is `queued` or `running` we
 * GET /api/jobs every 3s. As soon as everything is terminal we drop to a
 * 30s heartbeat (covers the "user kicked off a job, switched tabs, came
 * back" case). Polling is plenty for a single-engineer tool; switching to
 * Supabase Realtime would require exposing an anon key + RLS, which we've
 * deliberately avoided so far.
 *
 * Notifications + toast fire once per job, the first time we observe the
 * job in a terminal state. We track "already announced" jobIds in a ref so
 * a tab refresh doesn't re-fire announcements for already-completed jobs.
 */
type JobStatus = "queued" | "running" | "completed" | "failed"
type JobKind =
  | "audit"
  | "comp_analysis"
  | "initial_strategy"
  | "technical_crawl"
  | "alt_tags"

interface Job {
  id: string
  kind: JobKind
  status: JobStatus
  title: string
  result_path: string | null
  progress: { stage?: string; detail?: string; percent?: number | null }
  created_at: string
  updated_at: string
  error: string | null
}

const KIND_LABELS: Record<JobKind, string> = {
  audit: "Audit",
  comp_analysis: "Comp Analysis",
  initial_strategy: "Initial Strategy",
  technical_crawl: "Technical Crawl",
  alt_tags: "Alt Tags",
}

const ACTIVE_POLL_MS = 3000
const IDLE_POLL_MS = 30000
// Shared with components/JobsForKindCard. Dismissing a job from a per-tab
// card hides it here too; in-progress jobs cannot be dismissed.
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

export function JobsTray() {
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [open, setOpen] = useState(false)
  const announcedRef = useRef<Set<string>>(new Set())
  const initializedRef = useRef(false)
  // Re-read the dismissed set whenever the tray opens — otherwise dismissals
  // made on a per-tab card while the tray was closed wouldn't show up here
  // until the next poll tick that re-rendered the parent.
  const [dismissed, setDismissed] = useState<Set<string>>(() => readDismissed())
  useEffect(() => {
    if (open) setDismissed(readDismissed())
  }, [open])

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/jobs", { cache: "no-store" })
      if (!res.ok) return
      const body = (await res.json()) as { jobs: Job[] }
      setJobs(body.jobs ?? [])
    } catch {
      // Silently ignore — tray just won't update this tick.
    }
  }, [])

  // Seed once on mount, then poll. Interval depends on whether anything is
  // in flight.
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = async () => {
      if (cancelled) return
      await fetchJobs()
      if (cancelled) return
      const hasActive = (jobs ?? []).some(
        (j) => j.status === "queued" || j.status === "running",
      )
      const delay = hasActive ? ACTIVE_POLL_MS : IDLE_POLL_MS
      timer = setTimeout(tick, delay)
    }

    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
    // We deliberately don't depend on `jobs` — `tick` reads the latest via
    // closure-on-next-call, and adding it here would cancel/restart the
    // timer on every refresh. Instead we re-evaluate the delay inside tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchJobs])

  // On first jobs load, mark every existing terminal job as already
  // announced — we don't want to fire toasts for jobs that finished before
  // this tab was opened.
  useEffect(() => {
    if (!jobs) return
    if (initializedRef.current) return
    initializedRef.current = true
    for (const job of jobs) {
      if (job.status === "completed" || job.status === "failed") {
        announcedRef.current.add(job.id)
      }
    }
  }, [jobs])

  // Detect newly-terminal jobs and announce them.
  useEffect(() => {
    if (!jobs || !initializedRef.current) return
    for (const job of jobs) {
      const terminal = job.status === "completed" || job.status === "failed"
      if (!terminal) continue
      if (announcedRef.current.has(job.id)) continue
      announcedRef.current.add(job.id)
      announce(job)
    }
  }, [jobs])

  const visibleJobs = useMemo(
    () => (jobs ?? []).filter((j) => !dismissed.has(j.id)),
    [jobs, dismissed],
  )

  const activeCount = useMemo(
    () =>
      visibleJobs.filter(
        (j) => j.status === "queued" || j.status === "running",
      ).length,
    [visibleJobs],
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Background jobs"
          className="relative inline-flex h-9 w-9 items-center justify-center rounded text-foreground hover:bg-brand-sand/40"
        >
          <Bell className="h-5 w-5" />
          {activeCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 inline-flex min-w-[18px] items-center justify-center rounded-full bg-brand-red px-1 text-[10px] font-bold leading-[18px] text-white">
              {activeCount}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <div className="border-b px-4 py-3">
          <div className="text-[11px] font-extrabold uppercase tracking-[0.18em] text-ink-2">
            Background Jobs
          </div>
        </div>
        <div className="max-h-96 overflow-y-auto">
          {jobs === null ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              Loading…
            </div>
          ) : visibleJobs.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              No jobs in this session yet.
            </div>
          ) : (
            <ul className="divide-y">
              {visibleJobs.map((job) => (
                <li key={job.id} className="px-4 py-3">
                  <JobRow job={job} onNavigate={() => setOpen(false)} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function JobRow({ job, onNavigate }: { job: Job; onNavigate: () => void }) {
  const href = job.result_path ?? `/jobs/${job.id}`
  return (
    <div className="flex items-start gap-3">
      <StatusIcon status={job.status} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] font-extrabold uppercase tracking-[0.16em] text-ink-2">
            {KIND_LABELS[job.kind]}
          </span>
        </div>
        <div className="truncate text-sm font-medium">{job.title}</div>
        {job.status === "running" || job.status === "queued" ? (
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
        ) : null}
        {(job.status === "completed" || job.status === "failed") && (
          <Link
            href={href}
            onClick={onNavigate}
            className="mt-1 inline-block text-xs font-bold uppercase tracking-[0.12em] text-primary hover:underline"
          >
            View
          </Link>
        )}
      </div>
    </div>
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
  }
}

function announce(job: Job) {
  const label = KIND_LABELS[job.kind] ?? job.kind
  if (job.status === "completed") {
    toast.success(`${label} complete`, {
      description: job.title,
      action: {
        label: "View",
        onClick: () => {
          window.location.href = job.result_path ?? `/jobs/${job.id}`
        },
      },
    })
  } else {
    toast.error(`${label} failed`, {
      description: job.error ?? job.title,
    })
  }

  // Browser Notification — only if the user has granted permission. We
  // never auto-prompt; that's done explicitly when starting a job.
  if (
    typeof window !== "undefined" &&
    "Notification" in window &&
    Notification.permission === "granted"
  ) {
    try {
      new Notification(
        job.status === "completed"
          ? `${label} complete`
          : `${label} failed`,
        {
          body: job.title,
        },
      )
    } catch {
      // Some browsers throw when constructing Notification outside a SW
      // context; harmless.
    }
  }
}

/**
 * Helper used by task-starter buttons to politely request notification
 * permission the first time the user kicks off a job. No-op if already
 * granted or denied.
 */
export async function ensureNotificationPermission(): Promise<void> {
  if (typeof window === "undefined") return
  if (!("Notification" in window)) return
  if (Notification.permission === "default") {
    try {
      await Notification.requestPermission()
    } catch {
      /* ignore */
    }
  }
}
