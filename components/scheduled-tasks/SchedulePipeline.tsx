"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { toast } from "sonner"
import { Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { Partner } from "@/lib/types"
import { AddScheduleDialog } from "./AddScheduleDialog"
import type { Frequency, TaskKind, TaskSchedule } from "./types"

const KIND_LABELS: Record<TaskKind, string> = {
  technical_crawl: "Technical Crawl",
  full_audit: "Full Audit",
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
]

function formatSchedule(s: TaskSchedule): string {
  if (s.frequency === "daily") return "Every day"
  if (s.frequency === "weekly") {
    return `Every ${WEEKDAYS[s.day_of_week ?? 0] ?? "?"}`
  }
  return `Monthly on day ${s.day_of_month ?? "?"}`
}

function formatDate(iso: string | null): string {
  if (!iso) return "—"
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

/**
 * Schedule pipeline table — combined list of all task schedules across
 * both kinds (technical_crawl + full_audit). Rows expose pause/resume,
 * delete, and a "Last run" link to /jobs/<id> for the most recent run
 * the schedule produced.
 *
 * Editing a schedule's frequency/day is delete-and-recreate for now —
 * the PATCH endpoint supports inline edits but the UI is minimal here
 * to keep the dialog count down.
 */
export function SchedulePipeline() {
  const [partners, setPartners] = useState<Partner[]>([])
  const [subs, setSubs] = useState<TaskSchedule[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function reload() {
    setLoading(true)
    setError(null)
    try {
      const [partnersRes, subsRes] = await Promise.all([
        fetch("/api/airtable/partners"),
        fetch("/api/scheduled-tasks/subscriptions"),
      ])
      const partnersBody = (await partnersRes.json()) as {
        partners?: Partner[]
        error?: string
      }
      const subsBody = (await subsRes.json()) as {
        subscriptions?: TaskSchedule[]
        error?: string
      }
      if (!partnersRes.ok)
        throw new Error(partnersBody.error ?? `HTTP ${partnersRes.status}`)
      if (!subsRes.ok) throw new Error(subsBody.error ?? `HTTP ${subsRes.status}`)
      setPartners(
        (partnersBody.partners ?? [])
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name)),
      )
      setSubs(subsBody.subscriptions ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load schedules")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reload()
  }, [])

  async function toggle(s: TaskSchedule) {
    try {
      const res = await fetch(
        `/api/scheduled-tasks/subscriptions/${s.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: !s.enabled }),
        },
      )
      const json = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      await reload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to toggle")
    }
  }

  async function remove(s: TaskSchedule) {
    if (
      !window.confirm(
        `Remove the ${KIND_LABELS[s.kind].toLowerCase()} schedule for ${s.partner_name}?`,
      )
    )
      return
    try {
      const res = await fetch(
        `/api/scheduled-tasks/subscriptions/${s.id}`,
        { method: "DELETE" },
      )
      const json = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      toast.success("Schedule removed")
      await reload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete")
    }
  }

  async function runNow(s: TaskSchedule) {
    try {
      const res = await fetch("/api/jobs/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: s.kind,
          title: `${KIND_LABELS[s.kind]} (manual) — ${s.partner_name}`,
          input: { partnerId: s.partner_id },
        }),
      })
      const json = (await res.json()) as { jobId?: string; error?: string }
      if (!res.ok || !json.jobId) {
        throw new Error(json.error ?? `HTTP ${res.status}`)
      }
      toast.success("Run started", {
        description: "Recent runs below will update as it progresses.",
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start run")
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="font-sans text-sm font-extrabold uppercase tracking-[0.18em] text-muted-foreground">
            Pipeline
          </h2>
          <p className="mt-1 font-serif text-[14px] text-ink-2">
            Active schedules. Each partner can hold one schedule per task type.
          </p>
        </div>
        <AddScheduleDialog
          partners={partners}
          existing={subs}
          onCreated={reload}
        />
      </div>

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : subs.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
          No schedules yet. Add one above.
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Partner</TableHead>
                <TableHead>Task type</TableHead>
                <TableHead>Frequency</TableHead>
                <TableHead>Next run</TableHead>
                <TableHead>Last run</TableHead>
                <TableHead className="text-right">Status</TableHead>
                <TableHead className="w-40 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {subs.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.partner_name}</TableCell>
                  <TableCell>{KIND_LABELS[s.kind]}</TableCell>
                  <TableCell>{formatSchedule(s)}</TableCell>
                  <TableCell>{formatDate(s.next_run_at)}</TableCell>
                  <TableCell>
                    {s.last_job_id ? (
                      <Link
                        href={`/jobs/${s.last_job_id}`}
                        className="underline-offset-2 hover:underline"
                      >
                        {formatDate(s.last_run_at)}
                      </Link>
                    ) : (
                      formatDate(s.last_run_at)
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant={s.enabled ? "outline" : "secondary"}
                      onClick={() => toggle(s)}
                    >
                      {s.enabled ? "Enabled" : "Paused"}
                    </Button>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="inline-flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => runNow(s)}
                      >
                        Run now
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Remove ${s.partner_name}`}
                        onClick={() => remove(s)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  )
}

export type { Frequency }
