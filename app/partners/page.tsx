"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import type { DateRange } from "react-day-picker"
import { CalendarIcon, RefreshCwIcon, SearchIcon, XIcon } from "lucide-react"
import { PageHeader } from "@/components/PageHeader"
import { PartnerTile } from "@/components/partner-dashboard/PartnerTile"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import type { PartnerSnapshot } from "@/lib/types"

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

type ActivePreset = "last28" | "yoy" | "thisQ" | "thisQvsLastQ" | null

function defaultRange(): DateRange {
  const to = new Date()
  const from = new Date()
  from.setDate(to.getDate() - 27) // 28 days inclusive
  return { from, to }
}

function quarterStart(d: Date): Date {
  return new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1)
}

function yoyRange(today: Date): DateRange {
  return { from: new Date(today.getFullYear(), 0, 1), to: today }
}

function thisQRange(today: Date): DateRange {
  return { from: quarterStart(today), to: today }
}

function thisQvsLastQRange(today: Date): DateRange {
  const qStart = quarterStart(today)
  return { from: qStart, to: today }
}

function formatRange(range: DateRange | undefined): string {
  if (!range?.from) return "Pick a date range"
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
  if (!range.to) return fmt(range.from)
  return `${fmt(range.from)} – ${fmt(range.to)}`
}

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "done"
      snapshots: PartnerSnapshot[]
      cachedAt: string
      dateRange: { startDate: string; endDate: string }
    }

export default function PartnerDashboardPage() {
  const [range, setRange] = useState<DateRange | undefined>(defaultRange)
  const [activePreset, setActivePreset] = useState<ActivePreset>("last28")
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [state, setState] = useState<LoadState>({ status: "idle" })
  const [search, setSearch] = useState("")

  const load = useCallback(
    async (r: DateRange | undefined, bust = false) => {
      if (!r?.from || !r?.to) return
      const startDate = iso(r.from)
      const endDate = iso(r.to)
      setState({ status: "loading" })
      try {
        const url = new URL("/api/partners/snapshot", window.location.origin)
        url.searchParams.set("startDate", startDate)
        url.searchParams.set("endDate", endDate)
        if (bust) url.searchParams.set("bust", String(Date.now()))
        const res = await fetch(url.toString(), { cache: "no-store" })
        const body = (await res.json()) as {
          snapshots?: PartnerSnapshot[]
          cachedAt?: string
          dateRange?: { startDate: string; endDate: string }
          error?: string
        }
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
        const sorted = (body.snapshots ?? []).slice().sort((a, b) =>
          a.partner.name.localeCompare(b.partner.name),
        )
        setState({
          status: "done",
          snapshots: sorted,
          cachedAt: body.cachedAt ?? new Date().toISOString(),
          dateRange: body.dateRange ?? { startDate, endDate },
        })
      } catch (err) {
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "Failed to load dashboard",
        })
      }
    },
    [],
  )

  // Auto-load on mount with default range.
  useEffect(() => {
    load(defaultRange())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handleRangeChange(newRange: DateRange | undefined) {
    setRange(newRange)
    setActivePreset(null)
    if (newRange?.from && newRange?.to) {
      load(newRange)
    }
  }

  function applyPreset(preset: ActivePreset) {
    if (!preset) return
    const today = new Date()
    setActivePreset(preset)
    let r: DateRange
    if (preset === "last28") r = defaultRange()
    else if (preset === "yoy") r = yoyRange(today)
    else if (preset === "thisQ") r = thisQRange(today)
    else r = thisQvsLastQRange(today)
    setRange(r)
    load(r)
  }

  const noGsc =
    state.status === "done"
      ? state.snapshots.filter((s) => !s.gscSiteUrl).length
      : 0
  const hasAttention =
    state.status === "done"
      ? state.snapshots.filter((s) => s.latestRun?.needsAttention).length
      : 0

  const filteredSnapshots = useMemo(() => {
    if (state.status !== "done") return []
    const q = search.trim().toLowerCase()
    if (!q) return state.snapshots
    return state.snapshots.filter((s) => {
      const name = s.partner.name.toLowerCase()
      const website = s.partner.website.toLowerCase()
      return name.includes(q) || website.includes(q)
    })
  }, [state, search])

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Ongoing / Partner Dashboard"
        title="Partner Dashboard"
        tail="— health at a glance."
        subtitle={
          <>
            SEO health snapshot for all partners. Click any tile to view{" "}
            <b className="font-sans font-extrabold not-italic text-foreground">
              detailed metrics
            </b>
            , run DataForSEO actions, or generate a report.
          </>
        }
      />

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        {(
          [
            { id: "last28", label: "Last 28d" },
            { id: "yoy", label: "YoY" },
            { id: "thisQ", label: "This Qtr" },
            { id: "thisQvsLastQ", label: "Qtr vs Qtr" },
          ] as { id: ActivePreset; label: string }[]
        ).map(({ id, label }) => (
          <Button
            key={id}
            variant={activePreset === id ? "secondary" : "outline"}
            size="sm"
            className="h-9 px-3 text-sm"
            onClick={() => applyPreset(id)}
          >
            {label}
          </Button>
        ))}
        <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              className={cn(
                "w-[240px] justify-start text-left text-sm font-normal",
                !range?.from && "text-muted-foreground",
              )}
            >
              <CalendarIcon className="mr-2 size-4" />
              {formatRange(range)}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar
              mode="range"
              selected={range}
              onSelect={(r) => {
                setPopoverOpen(false)
                handleRangeChange(r)
              }}
              numberOfMonths={2}
              defaultMonth={range?.from}
            />
          </PopoverContent>
        </Popover>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => load(range, true)}
          disabled={state.status === "loading"}
        >
          <RefreshCwIcon
            className={cn("size-4", state.status === "loading" && "animate-spin")}
          />
          <span className="ml-1.5">Refresh</span>
        </Button>

        <div className="relative w-[260px]">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search partners…"
            className="h-9 pl-8 pr-8 text-sm"
            aria-label="Search partners by name or website"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <XIcon className="size-3.5" />
            </button>
          )}
        </div>

        {state.status === "done" && (
          <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
            {hasAttention > 0 && (
              <span className="text-amber-600">
                {hasAttention} partner{hasAttention > 1 ? "s" : ""} need attention
              </span>
            )}
            {noGsc > 0 && (
              <span>
                {noGsc} without GSC
              </span>
            )}
            <span>
              {search
                ? `${filteredSnapshots.length} of ${state.snapshots.length}`
                : `${state.snapshots.length} partners`}{" "}
              ·{" "}
              {new Date(state.cachedAt).toLocaleTimeString(undefined, {
                hour: "numeric",
                minute: "2-digit",
              })}
            </span>
          </div>
        )}
      </div>

      {/* Content */}
      {state.status === "loading" && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          {Array.from({ length: 12 }).map((_, i) => (
            <div
              key={i}
              className="h-36 animate-pulse rounded-xl border border-border bg-muted/30"
            />
          ))}
        </div>
      )}

      {state.status === "error" && (
        <p
          className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
          role="alert"
        >
          {state.message}
        </p>
      )}

      {state.status === "done" && state.snapshots.length === 0 && (
        <p className="text-sm text-muted-foreground">No partners found in Airtable.</p>
      )}

      {state.status === "done" &&
        state.snapshots.length > 0 &&
        filteredSnapshots.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No partners match &ldquo;{search}&rdquo;.
          </p>
        )}

      {state.status === "done" && filteredSnapshots.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          {filteredSnapshots.map((snapshot) => (
            <PartnerTile key={snapshot.partner.id} snapshot={snapshot} />
          ))}
        </div>
      )}
    </div>
  )
}
