"use client"

import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { Partner } from "@/lib/types"
import type { Frequency, TaskKind, TaskSchedule } from "./types"

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
]

interface Props {
  partners: Partner[]
  existing: TaskSchedule[]
  onCreated: () => void
}

/**
 * "Add schedule" dialog. Filters the partner picker to only those without
 * an existing schedule for the chosen task kind — re-scheduling requires
 * deleting the old row first (PATCH covers schedule changes; this dialog
 * only creates).
 */
export function AddScheduleDialog({ partners, existing, onCreated }: Props) {
  const [open, setOpen] = useState(false)
  const [partnerId, setPartnerId] = useState("")
  const [kind, setKind] = useState<TaskKind>("technical_crawl")
  const [frequency, setFrequency] = useState<Frequency>("monthly")
  const [dayOfWeek, setDayOfWeek] = useState(1)
  const [dayOfMonth, setDayOfMonth] = useState(1)
  const [submitting, setSubmitting] = useState(false)

  // Reset form on open so a previous abandoned attempt doesn't leak state.
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPartnerId("")
      setKind("technical_crawl")
      setFrequency("monthly")
      setDayOfWeek(1)
      setDayOfMonth(1)
    }
  }, [open])

  const taken = useMemo(
    () =>
      new Set(
        existing.filter((s) => s.kind === kind).map((s) => s.partner_id),
      ),
    [existing, kind],
  )
  const available = useMemo(
    () => partners.filter((p) => !taken.has(p.id)),
    [partners, taken],
  )

  async function submit() {
    if (!partnerId) {
      toast.error("Pick a partner")
      return
    }
    setSubmitting(true)
    try {
      const body: Record<string, unknown> = { partnerId, kind, frequency }
      if (frequency === "weekly") body.dayOfWeek = dayOfWeek
      if (frequency === "monthly") body.dayOfMonth = dayOfMonth
      const res = await fetch("/api/scheduled-tasks/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const json = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      toast.success("Schedule added")
      setOpen(false)
      onCreated()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add schedule")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>Add schedule</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add scheduled task</DialogTitle>
          <DialogDescription>
            Schedules fire when the desktop Routine bot ticks. A partner can
            have one schedule per task kind.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="add-kind">Task type</Label>
            <Select
              value={kind}
              onValueChange={(v) => setKind(v as TaskKind)}
              disabled={submitting}
            >
              <SelectTrigger id="add-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="technical_crawl">
                  Technical Crawl
                </SelectItem>
                <SelectItem value="full_audit">Full Audit</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="add-partner">Partner</Label>
            <Select
              value={partnerId}
              onValueChange={setPartnerId}
              disabled={submitting || available.length === 0}
            >
              <SelectTrigger id="add-partner">
                <SelectValue
                  placeholder={
                    available.length === 0
                      ? "All partners already scheduled for this task type"
                      : "Pick a partner…"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {available.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="add-freq">Frequency</Label>
            <Select
              value={frequency}
              onValueChange={(v) => setFrequency(v as Frequency)}
              disabled={submitting}
            >
              <SelectTrigger id="add-freq">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {frequency === "weekly" ? (
            <div className="space-y-2">
              <Label htmlFor="add-dow">Day of week</Label>
              <Select
                value={String(dayOfWeek)}
                onValueChange={(v) => setDayOfWeek(Number(v))}
                disabled={submitting}
              >
                <SelectTrigger id="add-dow">
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
          ) : null}

          {frequency === "monthly" ? (
            <div className="space-y-2">
              <Label htmlFor="add-dom">Day of month</Label>
              <Select
                value={String(dayOfMonth)}
                onValueChange={(v) => setDayOfMonth(Number(v))}
                disabled={submitting}
              >
                <SelectTrigger id="add-dom">
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
          ) : null}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting || !partnerId}>
            {submitting ? "Adding…" : "Add schedule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
