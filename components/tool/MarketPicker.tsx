"use client"

import { useEffect, useMemo, useState } from "react"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import type { DfsLabsLocation } from "@/lib/types"

/**
 * Single-market picker for tool pages. Same backing endpoint as
 * `LocationAutocomplete` (`/api/dataforseo/locations`), but constrained to
 * one selection and emits the chosen DFSEO location identifier back to
 * the parent.
 *
 * Used by every tool that needs a `location_code`. Pass `country` to seed
 * the picker with the country-level location for the typical SEMRush
 * pattern of "pick US-wide unless you want a city". Default is United
 * States (location_code 2840).
 */
export function MarketPicker({
  value,
  onChange,
  label = "Market",
  helpText,
  disabled,
  inputId = "tool-market",
}: {
  value: DfsLabsLocation | null
  onChange: (loc: DfsLabsLocation | null) => void
  label?: string
  helpText?: React.ReactNode
  disabled?: boolean
  inputId?: string
}) {
  const [query, setQuery] = useState(value?.location_name ?? "")
  const [results, setResults] = useState<DfsLabsLocation[]>([])
  const [open, setOpen] = useState(false)
  const [fetching, setFetching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)

  useEffect(() => {
    if (value && value.location_name !== query) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setQuery(value.location_name)
    }
    // Intentionally only react to value changes here, not query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  useEffect(() => {
    const abort = new AbortController()
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFetching(true)
    setError(null)

    const timer = setTimeout(async () => {
      try {
        const url = new URL(
          "/api/dataforseo/locations",
          window.location.origin,
        )
        if (query.trim()) url.searchParams.set("q", query.trim())
        const response = await fetch(url.toString(), { signal: abort.signal })
        const body = (await response.json().catch(() => ({}))) as {
          results?: DfsLabsLocation[]
          error?: string
        }
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
        if (!cancelled) {
          setResults(body.results ?? [])
          setActiveIndex(0)
        }
      } catch (err) {
        if (cancelled || (err instanceof Error && err.name === "AbortError")) {
          return
        }
        setError(err instanceof Error ? err.message : "Failed to load locations")
      } finally {
        if (!cancelled) setFetching(false)
      }
    }, 250)

    return () => {
      cancelled = true
      abort.abort()
      clearTimeout(timer)
    }
  }, [query])

  const handleSelect = (loc: DfsLabsLocation) => {
    onChange(loc)
    setQuery(loc.location_name)
    setOpen(false)
  }

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || results.length === 0) {
      if (e.key === "ArrowDown") setOpen(true)
      return
    }
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActiveIndex((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActiveIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      const pick = results[activeIndex]
      if (pick) handleSelect(pick)
    } else if (e.key === "Escape") {
      setOpen(false)
    }
  }

  const selectedSummary = useMemo(() => {
    if (!value) return null
    return `${value.location_name} (${value.location_type ?? "location"})`
  }, [value])

  return (
    <div className="space-y-1.5">
      <Label htmlFor={inputId}>{label}</Label>
      <div className="relative w-full">
        <input
          id={inputId}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
            if (value && e.target.value !== value.location_name) onChange(null)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={handleKey}
          placeholder="United States, New York City, 90210…"
          disabled={disabled}
          autoComplete="off"
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
        />
        {open ? (
          <ul
            role="listbox"
            className="absolute z-50 mt-1 max-h-[280px] w-full overflow-auto rounded-md border bg-popover p-1 text-sm shadow-md"
          >
            {fetching && results.length === 0 ? (
              <li className="px-2 py-1.5 text-muted-foreground">Searching…</li>
            ) : null}
            {error ? (
              <li className="px-2 py-1.5 text-destructive">{error}</li>
            ) : null}
            {!fetching && !error && results.length === 0 ? (
              <li className="px-2 py-1.5 text-muted-foreground">
                No matches. Try a broader search.
              </li>
            ) : null}
            {results.map((loc, i) => (
              <li
                key={loc.location_code}
                role="option"
                aria-selected={i === activeIndex}
                onMouseDown={(e) => {
                  e.preventDefault()
                  handleSelect(loc)
                }}
                onMouseEnter={() => setActiveIndex(i)}
                className={cn(
                  "flex cursor-pointer items-center justify-between gap-2 rounded-sm px-2 py-1.5",
                  i === activeIndex ? "bg-accent text-accent-foreground" : "",
                )}
              >
                <span className="truncate">{loc.location_name}</span>
                <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {loc.location_type}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {selectedSummary ? (
        <p className="font-mono text-[11px] text-ink-3">
          Selected: {selectedSummary} · code {value?.location_code}
        </p>
      ) : null}
      {helpText ? (
        <p className="text-xs text-muted-foreground">{helpText}</p>
      ) : null}
    </div>
  )
}
