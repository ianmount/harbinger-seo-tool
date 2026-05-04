"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

interface Run {
  id: string
  kind: string
  status: string
  title: string
  needs_attention: boolean
  attention_summary: unknown
  created_at: string
  completed_at: string | null
  result_path: string | null
}

const KIND_LABELS: Record<string, string> = {
  technical_crawl: "Technical Crawl",
  full_audit: "Full Audit",
}

function statusVariant(
  status: string,
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "completed") return "secondary"
  if (status === "failed" || status === "cancelled") return "destructive"
  return "default"
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

export function ScheduledTaskHistory({ partnerId }: { partnerId: string }) {
  const [runs, setRuns] = useState<Run[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/scheduled-tasks/recent-runs?partnerId=${encodeURIComponent(partnerId)}`,
        { cache: "no-store" },
      )
      const body = (await res.json()) as { runs?: Run[]; error?: string }
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      setRuns(body.runs ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load runs")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partnerId])

  // Poll while any in-flight jobs exist.
  useEffect(() => {
    if (!runs.some((r) => r.status === "queued" || r.status === "running"))
      return
    const t = setInterval(load, 30_000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs])

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-sans text-xs font-extrabold uppercase tracking-[0.18em] text-muted-foreground">
          Scheduled Task History
        </h3>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          onClick={load}
          disabled={loading}
        >
          Refresh
        </Button>
      </div>

      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : loading && runs.length === 0 ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : runs.length === 0 ? (
        <p className="text-xs text-muted-foreground">No runs yet for this partner.</p>
      ) : (
        <div className="divide-y divide-border rounded-lg border border-border text-xs">
          {runs.map((r) => (
            <div
              key={r.id}
              className="flex items-center justify-between gap-3 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">
                  {KIND_LABELS[r.kind] ?? r.kind}
                </p>
                <p className="text-muted-foreground">{fmtDate(r.created_at)}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {r.needs_attention && (
                  <Badge
                    variant="outline"
                    className="border-amber-500/40 bg-amber-500/10 text-[9px] text-amber-700"
                  >
                    {(r.attention_summary as { severity?: string })?.severity ??
                      "flagged"}
                  </Badge>
                )}
                <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                <Button asChild size="sm" variant="ghost" className="h-6 px-2 text-xs">
                  <Link href={r.result_path ?? `/jobs/${r.id}`}>View</Link>
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
