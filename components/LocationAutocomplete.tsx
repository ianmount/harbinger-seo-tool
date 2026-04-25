"use client"

import { useEffect, useMemo, useState } from "react"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import type { DfsLabsLocation } from "@/lib/types"

/**
 * Searchable picker for DataForSEO Labs locations.
 *
 * Backed by `/api/dataforseo/locations?q=<query>`, which returns the
 * subset of DFS's Google Ads US taxonomy that matches the typed string.
 * The user selects from the live list, which guarantees every code
 * passed downstream is one DataForSEO actually accepts — no city
 * code-resolution guesswork on the server.
 *
 * Lifted out of `app/keyword-research/page.tsx` so the Comp Analysis
 * tab (and any other Assessment tab that needs DFS-validated locations)
 * can reuse the same picker.
 */
export function LocationAutocomplete({
  initialQuery,
  selected,
  onAdd,
  onRemove,
  disabled,
  label,
  helpText,
  inputId = "dfs-location-search",
}: {
  initialQuery?: string
  selected: DfsLabsLocation[]
  onAdd: (loc: DfsLabsLocation) => void
  onRemove: (code: number) => void
  disabled?: boolean
  label?: string
  helpText?: React.ReactNode
  inputId?: string
}) {
  const [query, setQuery] = useState(initialQuery ?? "")
  const [results, setResults] = useState<DfsLabsLocation[]>([])
  const [fetching, setFetching] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)

  const selectedCodes = useMemo(
    () => new Set(selected.map((l) => l.location_code)),
    [selected],
  )

  // Re-seed the input when the initialQuery changes (e.g. when the user
  // navigates from the Audit tab with pre-filled target locations).
  useEffect(() => {
    if (initialQuery !== undefined) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setQuery(initialQuery)
    }
  }, [initialQuery])

  useEffect(() => {
    const abort = new AbortController()
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFetching(true)
    setFetchError(null)

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
        if (!response.ok) {
          throw new Error(body.error ?? `HTTP ${response.status}`)
        }
        if (!cancelled) {
          setResults(body.results ?? [])
          setActiveIndex(0)
        }
      } catch (err) {
        if (cancelled || (err instanceof Error && err.name === "AbortError")) {
          return
        }
        setFetchError(
          err instanceof Error ? err.message : "Failed to load locations",
        )
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
    if (selectedCodes.has(loc.location_code)) {
      setQuery("")
      setOpen(false)
      return
    }
    onAdd(loc)
    setQuery("")
    setOpen(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
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

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2">
        {label ? <Label htmlFor={inputId}>{label}</Label> : null}
        <div className="relative w-full max-w-[420px]">
          <input
            id={inputId}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setOpen(true)
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => {
              setTimeout(() => setOpen(false), 150)
            }}
            onKeyDown={handleKeyDown}
            placeholder="Search: city, state, zip, or country…"
            disabled={disabled}
            autoComplete="off"
            role="combobox"
            aria-expanded={open}
            aria-controls={`${inputId}-listbox`}
            aria-activedescendant={
              open && results[activeIndex]
                ? `${inputId}-opt-${results[activeIndex].location_code}`
                : undefined
            }
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
          />
          {open ? (
            <ul
              id={`${inputId}-listbox`}
              role="listbox"
              className="absolute z-50 mt-1 max-h-[320px] w-full overflow-auto rounded-md border bg-popover p-1 text-sm shadow-md"
            >
              {fetching && results.length === 0 ? (
                <li className="px-2 py-1.5 text-muted-foreground">Searching…</li>
              ) : null}
              {fetchError ? (
                <li className="px-2 py-1.5 text-destructive">{fetchError}</li>
              ) : null}
              {!fetching && !fetchError && results.length === 0 ? (
                <li className="px-2 py-1.5 text-muted-foreground">
                  No matches. Try a broader search.
                </li>
              ) : null}
              {results.map((loc, i) => {
                const alreadyAdded = selectedCodes.has(loc.location_code)
                return (
                  <li
                    key={loc.location_code}
                    id={`${inputId}-opt-${loc.location_code}`}
                    role="option"
                    aria-selected={i === activeIndex}
                    aria-disabled={alreadyAdded}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      if (!alreadyAdded) handleSelect(loc)
                    }}
                    onMouseEnter={() => setActiveIndex(i)}
                    className={cn(
                      "flex items-center justify-between gap-2 rounded-sm px-2 py-1.5",
                      alreadyAdded
                        ? "cursor-not-allowed opacity-50"
                        : "cursor-pointer",
                      i === activeIndex && !alreadyAdded
                        ? "bg-accent text-accent-foreground"
                        : "",
                    )}
                  >
                    <span className="truncate">{loc.location_name}</span>
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {alreadyAdded ? "added" : loc.location_type}
                    </span>
                  </li>
                )
              })}
            </ul>
          ) : null}
        </div>

        {selected.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5">
            {selected.map((loc) => (
              <li
                key={loc.location_code}
                className="inline-flex items-center gap-1 rounded-full border bg-secondary px-2 py-0.5 text-xs"
              >
                <span className="font-mono">{loc.location_name}</span>
                <span className="text-[9px] uppercase tracking-wide text-muted-foreground">
                  {loc.location_type}
                </span>
                <button
                  type="button"
                  onClick={() => onRemove(loc.location_code)}
                  disabled={disabled}
                  aria-label={`Remove ${loc.location_name}`}
                  className="ml-0.5 rounded-full px-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {helpText ? (
          <p className="text-xs text-muted-foreground">{helpText}</p>
        ) : null}
      </div>
    </div>
  )
}
