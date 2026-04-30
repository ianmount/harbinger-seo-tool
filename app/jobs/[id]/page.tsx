"use client"

import { useEffect, useState } from "react"
import { useParams } from "next/navigation"
import Link from "next/link"
import { CheckCircle2, Loader2, XCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

/**
 * Generic landing page for a background job. Most kinds will set their own
 * `result_path` when starting (e.g. /audits/<id>) and the user will never
 * see this page; it exists so jobs without a dedicated result viewer still
 * have somewhere to land — and so failed jobs can show their error message
 * before the user retries.
 */

interface Job {
  id: string
  kind: string
  status: "queued" | "running" | "completed" | "failed"
  title: string
  result: unknown
  result_path: string | null
  progress: { stage?: string; detail?: string; percent?: number | null }
  error: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

const KIND_LABELS: Record<string, string> = {
  audit: "Audit",
  comp_analysis: "Competitive Analysis",
  initial_strategy: "Initial Strategy",
  technical_crawl: "Technical Crawl",
  alt_tags: "Alt Tags",
}

export default function JobsLandingPage() {
  const params = useParams<{ id: string }>()
  const id = params?.id
  const [job, setJob] = useState<Job | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = async () => {
      try {
        const res = await fetch(`/api/jobs/${id}`, { cache: "no-store" })
        if (!res.ok) {
          setError(res.status === 404 ? "Job not found." : "Failed to load job.")
          return
        }
        const body = (await res.json()) as { job: Job }
        if (cancelled) return
        setJob(body.job)
        if (body.job.status === "queued" || body.job.status === "running") {
          timer = setTimeout(tick, 3000)
        }
      } catch {
        if (!cancelled) setError("Network error.")
      }
    }
    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [id])

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Job</CardTitle>
          <CardDescription>{error}</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  if (!job) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading job…
      </div>
    )
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[10px] font-extrabold uppercase tracking-[0.18em] text-ink-2">
              {KIND_LABELS[job.kind] ?? job.kind}
            </div>
            <CardTitle className="mt-1">{job.title}</CardTitle>
            <CardDescription>
              Started {new Date(job.created_at).toLocaleString()}
            </CardDescription>
          </div>
          <StatusBadge status={job.status} />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {job.status === "queued" || job.status === "running" ? (
          <div className="rounded-md border bg-muted/40 p-3 text-sm">
            <div className="font-medium">
              {job.progress?.stage ?? "Running…"}
            </div>
            {job.progress?.detail && (
              <div className="mt-1 text-muted-foreground">
                {job.progress.detail}
              </div>
            )}
          </div>
        ) : null}

        {job.status === "failed" && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <div className="font-medium text-destructive">Failed</div>
            <pre className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">
              {job.error ?? "(no error message)"}
            </pre>
          </div>
        )}

        {job.status === "completed" && job.result_path && (
          <Button asChild>
            <Link href={job.result_path}>Open results</Link>
          </Button>
        )}

        {job.status === "completed" && !job.result_path && (
          <div className="rounded-md border bg-muted/40 p-3 text-sm">
            <div className="font-medium">Result</div>
            <pre className="mt-1 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">
              {JSON.stringify(job.result, null, 2)}
            </pre>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function StatusBadge({ status }: { status: Job["status"] }) {
  const base =
    "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-[0.16em]"
  if (status === "completed") {
    return (
      <span className={`${base} bg-emerald-100 text-emerald-700`}>
        <CheckCircle2 className="h-3 w-3" /> Completed
      </span>
    )
  }
  if (status === "failed") {
    return (
      <span className={`${base} bg-destructive/15 text-destructive`}>
        <XCircle className="h-3 w-3" /> Failed
      </span>
    )
  }
  return (
    <span className={`${base} bg-primary/10 text-primary`}>
      <Loader2 className="h-3 w-3 animate-spin" />{" "}
      {status === "queued" ? "Queued" : "Running"}
    </span>
  )
}
