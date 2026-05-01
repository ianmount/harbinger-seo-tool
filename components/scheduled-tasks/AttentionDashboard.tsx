"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { AlertTriangle, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { AttentionItem } from "./types"

const DISMISSED_KEY = "harbinger:dismissed_attention"

/**
 * "Needs Attention" cards above the schedule pipeline. Surfaces recent
 * scheduled-task jobs whose results carry a `needs_attention` flag —
 * broken pages, high-severity audit findings, etc.
 *
 * Dismissal is client-side (localStorage) — clicking X hides the card on
 * this browser only. The underlying job row stays in the DB. Mirrors the
 * JobsTray dismissal pattern.
 */

const KIND_LABELS: Record<AttentionItem["kind"], string> = {
  technical_crawl: "Technical Crawl",
  full_audit: "Full Audit",
}

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
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(Array.from(ids)))
  } catch {
    /* quota errors */
  }
}

function severityClasses(
  sev: "high" | "medium" | "low",
): { card: string; badge: string; label: string } {
  if (sev === "high") {
    return {
      card: "border-destructive/50 bg-destructive/5",
      badge: "bg-destructive/15 text-destructive border-destructive/30",
      label: "High",
    }
  }
  if (sev === "medium") {
    return {
      card: "border-amber-500/50 bg-amber-500/5",
      badge: "bg-amber-500/15 text-amber-700 border-amber-500/30",
      label: "Medium",
    }
  }
  return {
    card: "border-sky-500/40 bg-sky-500/5",
    badge: "bg-sky-500/15 text-sky-700 border-sky-500/30",
    label: "Low",
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return "—"
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

export function AttentionDashboard() {
  const [items, setItems] = useState<AttentionItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState<Set<string>>(() => readDismissed())

  async function reload() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/scheduled-tasks/attention", { cache: "no-store" })
      const body = (await res.json()) as { items?: AttentionItem[]; error?: string }
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      setItems(body.items ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load attention items")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reload()
  }, [])

  function dismiss(id: string) {
    const next = new Set(dismissed)
    next.add(id)
    setDismissed(next)
    writeDismissed(next)
  }

  function restoreAll() {
    const empty = new Set<string>()
    setDismissed(empty)
    writeDismissed(empty)
  }

  const visible = items.filter((it) => !dismissed.has(it.id))

  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="font-sans text-sm font-extrabold uppercase tracking-[0.18em] text-muted-foreground">
            Needs attention
          </h2>
          <p className="mt-1 font-serif text-[14px] text-ink-2">
            Scheduled runs that flagged issues a human should review.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {dismissed.size > 0 ? (
            <Button size="sm" variant="ghost" onClick={restoreAll}>
              Restore dismissed ({dismissed.size})
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={reload} disabled={loading}>
            Refresh
          </Button>
        </div>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : loading && items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : visible.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
          {items.length === 0
            ? "Nothing flagged. Scheduled runs that find issues will surface here."
            : "All flagged items dismissed on this browser."}
        </div>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((item) => {
            const sev = item.attention_summary?.severity ?? "low"
            const classes = severityClasses(sev)
            const issues = item.attention_summary?.issues ?? []
            const target = item.result_path ?? `/jobs/${item.id}`
            return (
              <li
                key={item.id}
                className={cn(
                  "rounded-md border p-4 transition-shadow",
                  classes.card,
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-foreground" />
                    <Badge variant="outline" className={classes.badge}>
                      {classes.label}
                    </Badge>
                    <span className="text-[10px] font-extrabold uppercase tracking-[0.16em] text-muted-foreground">
                      {KIND_LABELS[item.kind]}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => dismiss(item.id)}
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label="Dismiss"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <h3 className="mt-3 font-sans text-[14px] font-extrabold leading-snug">
                  {item.title}
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatDate(item.completed_at ?? item.created_at)}
                </p>
                {issues.length > 0 ? (
                  <ul className="mt-3 space-y-1.5">
                    {issues.slice(0, 4).map((issue, i) => (
                      <li key={i} className="text-sm">
                        <span className="font-medium">{issue.title}</span>
                        {issue.count != null ? (
                          <span className="text-muted-foreground">
                            {" "}
                            · {issue.count}
                          </span>
                        ) : null}
                        {issue.detail ? (
                          <span className="block text-xs text-muted-foreground">
                            {issue.detail}
                          </span>
                        ) : null}
                      </li>
                    ))}
                    {issues.length > 4 ? (
                      <li className="text-xs text-muted-foreground">
                        +{issues.length - 4} more
                      </li>
                    ) : null}
                  </ul>
                ) : null}
                <div className="mt-4">
                  <Button asChild size="sm" variant="outline">
                    <Link href={target}>Open report</Link>
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
