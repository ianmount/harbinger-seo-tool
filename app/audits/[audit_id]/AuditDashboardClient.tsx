"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Dashboard } from "@/components/audit-dashboard/Dashboard"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { buildDashboardData } from "@/lib/audit-dashboard-data"
import { loadAudit, saveAudit, type StoredAudit } from "@/lib/audit-storage"
import { renderStandaloneHtml } from "@/lib/audit-html-export"
import { useAssessment } from "@/lib/assessment-context"
import type { AssessmentAuditResult } from "@/lib/types"

/**
 * Audit dashboard with three load paths, tried in order:
 *  1. sessionStorage — existing in-tab flow (legacy /audit synchronous flow
 *     wrote here too; preserved for fast in-tab navigations).
 *  2. /api/jobs/<id> — when audit_id is a background job id (the new flow).
 *     If still in flight, polls the job until terminal and renders progress
 *     in the meantime. On completion, hydrates from `job.result.audit`,
 *     mirrors into sessionStorage, and pushes into AssessmentContext so the
 *     Comp Analysis tab can pre-fill.
 *  3. AssessmentContext fallback — if a result is already in memory but
 *     storage was wiped, reuse it.
 */

interface JobShape {
  id: string
  status: "queued" | "running" | "completed" | "failed" | "cancelled"
  title: string
  result: { audit: AssessmentAuditResult; costUsd?: number } | null
  progress: { stage?: string; detail?: string }
  error: string | null
}

export function AuditDashboardClient({ auditId }: { auditId: string }) {
  const { state, setField } = useAssessment()
  const [stored, setStored] = useState<StoredAudit | null>(null)
  const [hydrated, setHydrated] = useState(false)
  const [job, setJob] = useState<JobShape | null>(null)
  const [jobError, setJobError] = useState<string | null>(null)
  const seededFromContext = useRef(false)

  // 1. Sessionstorage / context first; falls through to job lookup if neither.
  useEffect(() => {
    const fromStorage = loadAudit(auditId)
    if (fromStorage) {
      setStored(fromStorage)
      setHydrated(true)
      return
    }
    if (state.auditResult) {
      const fallback: StoredAudit = {
        id: auditId,
        result: state.auditResult,
        compAnalysisRows: state.compAnalysisRows,
        storedAt: new Date().toISOString(),
      }
      saveAudit(fallback)
      setStored(fallback)
      seededFromContext.current = true
      setHydrated(true)
    }
    // No early-mark of `hydrated` here — the job poller below decides when
    // to flip it for the not-in-storage case.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auditId])

  // 2. Job lookup + polling. Only runs if neither sessionStorage nor context
  // had the audit. The poller backs off as soon as the job hits a terminal
  // state.
  useEffect(() => {
    if (stored) return
    if (seededFromContext.current) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = async () => {
      try {
        const res = await fetch(`/api/jobs/${auditId}`, { cache: "no-store" })
        if (cancelled) return
        if (res.status === 404) {
          // Not a job id either — show the "not found" empty state.
          setJob(null)
          setHydrated(true)
          return
        }
        if (!res.ok) {
          setJobError(`Failed to load audit job (HTTP ${res.status}).`)
          setHydrated(true)
          return
        }
        const body = (await res.json()) as { job: JobShape }
        setJob(body.job)
        setHydrated(true)
        if (body.job.status === "completed" && body.job.result?.audit) {
          const auditResult = body.job.result.audit
          const next: StoredAudit = {
            id: auditId,
            result: auditResult,
            compAnalysisRows: state.compAnalysisRows,
            storedAt: new Date().toISOString(),
          }
          saveAudit(next)
          setStored(next)
          // Mirror into AssessmentContext so the Comp Analysis tab and chat
          // widget see the result. Only do it the first time we observe
          // completion to avoid clobbering the user's edits.
          setField("auditResult", auditResult)
        } else if (
          body.job.status !== "failed" &&
          body.job.status !== "cancelled"
        ) {
          timer = setTimeout(tick, 3000)
        }
      } catch (err) {
        if (cancelled) return
        setJobError(
          err instanceof Error ? err.message : "Network error loading audit",
        )
        setHydrated(true)
      }
    }

    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
    // We intentionally exclude state.compAnalysisRows + setField from deps
    // so the poller isn't restarted on every keystroke in another tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auditId, stored])

  const data = useMemo(() => {
    if (!stored) return null
    return buildDashboardData(stored.result, {
      compAnalysisRows: stored.compAnalysisRows ?? state.compAnalysisRows,
    })
  }, [stored, state.compAnalysisRows])

  const handleDownloadHtml = useCallback(() => {
    if (!data || !stored) return
    try {
      const html = renderStandaloneHtml(data)
      const blob = new Blob([html], { type: "text/html;charset=utf-8" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      const safeDomain = data.domain.replace(/[^a-z0-9.-]/gi, "_")
      const date = data.generatedAt.slice(0, 10)
      a.href = url
      a.download = `audit-${safeDomain}-${date}.html`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      toast.success("HTML download started")
    } catch (err) {
      toast.error("Could not generate HTML", {
        description: err instanceof Error ? err.message : "Unknown error",
      })
    }
  }, [data, stored])

  const handlePrint = useCallback(() => {
    window.print()
  }, [])

  if (!hydrated) {
    return (
      <p className="font-serif text-[14px] italic text-ink-2">
        Loading audit…
      </p>
    )
  }

  // In-flight job — render progress card. Keep polling.
  if (!data && job && (job.status === "queued" || job.status === "running")) {
    return (
      <Card>
        <CardHeader>
          <div className="text-[10px] font-extrabold uppercase tracking-[0.18em] text-ink-2">
            Audit in progress
          </div>
          <CardTitle className="mt-1">{job.title}</CardTitle>
          <CardDescription>
            You can close this tab — we&apos;ll email you when it&apos;s ready,
            or check back here any time.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
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

  // Cancelled job — show short note + retry CTA.
  if (!data && job && job.status === "cancelled") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Audit cancelled</CardTitle>
          <CardDescription>{job.title}</CardDescription>
        </CardHeader>
        <CardContent>
          <Link
            href="/audit"
            className="inline-flex items-center rounded-md bg-brand-navy px-4 py-2 font-sans text-[11.5px] font-bold uppercase tracking-[0.08em] text-brand-cream"
          >
            Run a new audit
          </Link>
        </CardContent>
      </Card>
    )
  }

  // Failed job — show error.
  if (!data && job && job.status === "failed") {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-destructive">Audit failed</CardTitle>
          <CardDescription>{job.title}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <pre className="whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
            {job.error ?? "(no error message)"}
          </pre>
          <Link
            href="/audit"
            className="inline-flex items-center rounded-md bg-brand-navy px-4 py-2 font-sans text-[11.5px] font-bold uppercase tracking-[0.08em] text-brand-cream"
          >
            Run a new audit
          </Link>
        </CardContent>
      </Card>
    )
  }

  // Generic load error.
  if (!data && jobError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Couldn&apos;t load audit</CardTitle>
          <CardDescription>{jobError}</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  // Not in storage, not a known job — original "not found" empty state.
  if (!data) {
    return (
      <div className="rounded-[10px] border border-line bg-card p-6 text-center">
        <p className="eyebrow eyebrow-red">Audit not found</p>
        <p className="mt-3 font-serif text-[15px] italic text-ink-2">
          We couldn&apos;t find an audit with the id{" "}
          <code className="not-italic">{auditId}</code>. Audit results expire
          when you log out.
        </p>
        <div className="mt-5">
          <Link
            href="/audit"
            className="inline-flex items-center rounded-md bg-brand-navy px-4 py-2 font-sans text-[11.5px] font-bold uppercase tracking-[0.08em] text-brand-cream"
          >
            Run a new audit
          </Link>
        </div>
      </div>
    )
  }

  return (
    <Dashboard
      data={data}
      onDownloadHtml={handleDownloadHtml}
      onPrint={handlePrint}
    />
  )
}
