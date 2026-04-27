"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { toast } from "sonner"
import { Dashboard } from "@/components/audit-dashboard/Dashboard"
import { buildDashboardData } from "@/lib/audit-dashboard-data"
import { loadAudit, saveAudit, type StoredAudit } from "@/lib/audit-storage"
import { renderStandaloneHtml } from "@/lib/audit-html-export"
import { useAssessment } from "@/lib/assessment-context"

export function AuditDashboardClient({ auditId }: { auditId: string }) {
  const { state } = useAssessment()
  const [stored, setStored] = useState<StoredAudit | null>(null)
  const [hydrated, setHydrated] = useState(false)

  /* eslint-disable react-hooks/set-state-in-effect --
     One-shot post-mount load from sessionStorage / context fallback;
     no external system to subscribe to, so the cascading-render concern
     the rule guards against doesn't apply here. */
  useEffect(() => {
    // sessionStorage is only available in the browser, so the lookup runs
    // post-mount. Falls back to the in-memory assessment context when the
    // user navigates here straight from /audit before storage was written.
    const fromStorage = loadAudit(auditId)
    if (fromStorage) {
      setStored(fromStorage)
    } else if (state.auditResult) {
      const fallback: StoredAudit = {
        id: auditId,
        result: state.auditResult,
        compAnalysisRows: state.compAnalysisRows,
        storedAt: new Date().toISOString(),
      }
      saveAudit(fallback)
      setStored(fallback)
    }
    setHydrated(true)
  }, [auditId, state.auditResult, state.compAnalysisRows])
  /* eslint-enable react-hooks/set-state-in-effect */

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

  if (!data) {
    return (
      <div className="rounded-[10px] border border-line bg-card p-6 text-center">
        <p className="eyebrow eyebrow-red">Audit not found</p>
        <p className="mt-3 font-serif text-[15px] italic text-ink-2">
          We couldn&apos;t find an audit with the id{" "}
          <code className="not-italic">{auditId}</code>. Audits are stored
          in-tab only — refreshing or closing the tab clears them.
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
