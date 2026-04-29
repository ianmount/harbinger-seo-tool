"use client"

import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { Partner } from "@/lib/types"
import type { Frequency, Subscription } from "./types"

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
]

function formatSchedule(s: Subscription): string {
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
 * Per-partner subscription manager. New subscriptions are created via a
 * small inline form; the table below shows everything currently scheduled
 * with toggle / delete controls. Schedules are advanced server-side after
 * each successful routine fire — this component is purely a config view.
 */
export function SchedulesPanel() {
  const [partners, setPartners] = useState<Partner[]>([])
  const [subs, setSubs] = useState<Subscription[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Form state for creating/upserting a subscription.
  const [partnerId, setPartnerId] = useState<string>("")
  const [frequency, setFrequency] = useState<Frequency>("monthly")
  const [dayOfWeek, setDayOfWeek] = useState<number>(1) // Monday
  const [dayOfMonth, setDayOfMonth] = useState<number>(1)
  const [submitting, setSubmitting] = useState(false)

  async function reload() {
    setLoading(true)
    setError(null)
    try {
      const [partnersRes, subsRes] = await Promise.all([
        fetch("/api/airtable/partners"),
        fetch("/api/technical-crawls/subscriptions"),
      ])
      const partnersBody = (await partnersRes.json()) as {
        partners?: Partner[]
        error?: string
      }
      const subsBody = (await subsRes.json()) as {
        subscriptions?: Subscription[]
        error?: string
      }
      if (!partnersRes.ok) throw new Error(partnersBody.error ?? `HTTP ${partnersRes.status}`)
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
    reload()
  }, [])

  // Filter the partner picker so already-subscribed partners don't appear
  // by default. Re-subscribing requires deleting the existing row first
  // (or editing — current UI is delete-and-recreate; PATCH is exposed via
  // the toggle button, not a full edit form, to keep this small).
  const subscribedIds = useMemo(
    () => new Set(subs.map((s) => s.partner_id)),
    [subs],
  )
  const availablePartners = useMemo(
    () => partners.filter((p) => !subscribedIds.has(p.id)),
    [partners, subscribedIds],
  )

  async function handleAdd() {
    if (!partnerId) {
      toast.error("Pick a partner")
      return
    }
    setSubmitting(true)
    try {
      const body =
        frequency === "weekly"
          ? { partnerId, frequency: "weekly" as const, dayOfWeek }
          : { partnerId, frequency: "monthly" as const, dayOfMonth }
      const res = await fetch("/api/technical-crawls/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const json = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      toast.success("Schedule added")
      setPartnerId("")
      await reload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add schedule")
    } finally {
      setSubmitting(false)
    }
  }

  async function handleToggle(s: Subscription) {
    try {
      const res = await fetch(`/api/technical-crawls/subscriptions/${s.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !s.enabled }),
      })
      const json = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      await reload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to toggle")
    }
  }

  async function handleDelete(s: Subscription) {
    if (!window.confirm(`Remove the scheduled crawl for ${s.partner_name}?`)) return
    try {
      const res = await fetch(`/api/technical-crawls/subscriptions/${s.id}`, {
        method: "DELETE",
      })
      const json = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      toast.success("Schedule removed")
      await reload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete")
    }
  }

  return (
    <div className="space-y-8">
      <section className="space-y-3 rounded-md border border-border bg-card p-4">
        <h2 className="font-sans text-sm font-extrabold uppercase tracking-[0.18em] text-muted-foreground">
          Add schedule
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-2">
            <Label htmlFor="sched-partner">Partner</Label>
            <Select
              value={partnerId}
              onValueChange={setPartnerId}
              disabled={submitting || availablePartners.length === 0}
            >
              <SelectTrigger id="sched-partner">
                <SelectValue
                  placeholder={
                    availablePartners.length === 0
                      ? "All partners scheduled"
                      : "Pick a partner…"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {availablePartners.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="sched-freq">Frequency</Label>
            <Select
              value={frequency}
              onValueChange={(v) => setFrequency(v as Frequency)}
              disabled={submitting}
            >
              <SelectTrigger id="sched-freq">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="monthly">Monthly</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {frequency === "weekly" ? (
            <div className="space-y-2">
              <Label htmlFor="sched-dow">Day of week</Label>
              <Select
                value={String(dayOfWeek)}
                onValueChange={(v) => setDayOfWeek(Number(v))}
                disabled={submitting}
              >
                <SelectTrigger id="sched-dow">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WEEKDAYS.map((label, i) => (
                    <SelectItem key={i} value={String(i)}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="sched-dom">Day of month</Label>
              <Select
                value={String(dayOfMonth)}
                onValueChange={(v) => setDayOfMonth(Number(v))}
                disabled={submitting}
              >
                <SelectTrigger id="sched-dom">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                    <SelectItem key={d} value={String(d)}>
                      {d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Day 29-31 is clamped to the last day of shorter months.
              </p>
            </div>
          )}
          <div className="flex items-end">
            <Button onClick={handleAdd} disabled={submitting || !partnerId}>
              {submitting ? "Adding…" : "Add schedule"}
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Schedules are picked up by the daily Claude Code Routine. The
          Routine fires any subscription whose next run is in the past, so
          a missed day catches up on the next tick.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="font-sans text-sm font-extrabold uppercase tracking-[0.18em] text-muted-foreground">
          Active schedules
        </h2>
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : subs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No partners scheduled. Add one above.
          </p>
        ) : (
          <div className="overflow-hidden rounded-md border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Partner</TableHead>
                  <TableHead>Schedule</TableHead>
                  <TableHead>Next run</TableHead>
                  <TableHead>Last run</TableHead>
                  <TableHead className="text-right">Status</TableHead>
                  <TableHead className="w-12 text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {subs.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">
                      {s.partner_name}
                    </TableCell>
                    <TableCell>{formatSchedule(s)}</TableCell>
                    <TableCell>{formatDate(s.next_run_at)}</TableCell>
                    <TableCell>{formatDate(s.last_run_at)}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant={s.enabled ? "outline" : "secondary"}
                        onClick={() => handleToggle(s)}
                      >
                        {s.enabled ? "Enabled" : "Paused"}
                      </Button>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Remove ${s.partner_name}`}
                        onClick={() => handleDelete(s)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  )
}
