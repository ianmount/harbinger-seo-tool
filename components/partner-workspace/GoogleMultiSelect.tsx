"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  CheckIcon,
  ChevronDownIcon,
  Loader2Icon,
  SearchIcon,
  XIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import type { GoogleAccountSlug } from "@/lib/types"

/**
 * Multi-select popover for picking N items grouped by Google account.
 *
 * Generic over the option shape — used for both GSC sites and GA4
 * properties from the Onboard Partner form and the partner Settings tab.
 *
 * UX:
 *   • Trigger button shows "Select <kind>" or "N selected".
 *   • Popover opens with a search input at the top; typing filters every
 *     visible option by label + sublabel (case-insensitive substring).
 *   • Filtered options stay grouped by account, with a checkmark next to
 *     the selected ones. Clicking toggles inclusion.
 *   • Selected chips render below the trigger with × buttons.
 */

export interface GoogleMultiSelectOption {
  /** Stable identity (e.g. siteUrl or propertyId). */
  id: string
  /** Which Google account this option lives under. */
  account: GoogleAccountSlug
  /** Display label inside the popover. */
  label: string
  /** Optional sub-label (e.g. property's website URL). */
  sublabel?: string
}

export interface GoogleMultiSelectProps {
  /** All available options across both accounts. */
  options: GoogleMultiSelectOption[]
  /** Currently selected (id, account) pairs. */
  value: Array<{ id: string; account: GoogleAccountSlug }>
  onChange: (next: Array<{ id: string; account: GoogleAccountSlug }>) => void
  loading?: boolean
  /** "GSC site" / "GA4 property" etc. — used in the trigger placeholder. */
  itemNoun: string
  /** Pluralised form for the count, e.g. "sites" / "properties". */
  itemNounPlural: string
  /** Optional inline note (errors, refresh hint). */
  helperText?: React.ReactNode
}

function selectionKey(account: GoogleAccountSlug, id: string): string {
  return `${account}::${id}`
}

export function GoogleMultiSelect({
  options,
  value,
  onChange,
  loading,
  itemNoun,
  itemNounPlural,
  helperText,
}: GoogleMultiSelectProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const searchInputRef = useRef<HTMLInputElement | null>(null)

  // Reset search query when the popover closes so reopening always starts fresh.
  useEffect(() => {
    if (!open) setQuery("")
  }, [open])

  const selectedKeys = useMemo(() => {
    const s = new Set<string>()
    for (const v of value) s.add(selectionKey(v.account, v.id))
    return s
  }, [value])

  const filteredOptions = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter((opt) => {
      const hay = `${opt.label} ${opt.sublabel ?? ""}`.toLowerCase()
      return hay.includes(q)
    })
  }, [options, query])

  const optionsByAccount = useMemo(() => {
    const out: Record<GoogleAccountSlug, GoogleMultiSelectOption[]> = {
      partners: [],
      assessments: [],
    }
    for (const opt of filteredOptions) out[opt.account].push(opt)
    return out
  }, [filteredOptions])

  const labelByKey = useMemo(() => {
    const m = new Map<string, GoogleMultiSelectOption>()
    for (const opt of options) m.set(selectionKey(opt.account, opt.id), opt)
    return m
  }, [options])

  function toggle(opt: GoogleMultiSelectOption) {
    const key = selectionKey(opt.account, opt.id)
    if (selectedKeys.has(key)) {
      onChange(
        value.filter((v) => selectionKey(v.account, v.id) !== key),
      )
    } else {
      onChange([...value, { id: opt.id, account: opt.account }])
    }
  }

  function remove(account: GoogleAccountSlug, id: string) {
    const key = selectionKey(account, id)
    onChange(value.filter((v) => selectionKey(v.account, v.id) !== key))
  }

  const triggerLabel =
    value.length === 0
      ? loading
        ? `Loading ${itemNounPlural}…`
        : `Select ${itemNounPlural} (optional)`
      : value.length === 1
        ? `1 ${itemNoun} selected`
        : `${value.length} ${itemNounPlural} selected`

  return (
    <div className="space-y-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className={cn(
              "w-full justify-between font-normal",
              value.length === 0 && "text-muted-foreground",
            )}
            disabled={loading && options.length === 0}
          >
            <span className="truncate">{triggerLabel}</span>
            {loading ? (
              <Loader2Icon className="ml-2 size-4 animate-spin" />
            ) : (
              <ChevronDownIcon className="ml-2 size-4 shrink-0 opacity-60" />
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-[--radix-popover-trigger-width] p-0"
          align="start"
          onOpenAutoFocus={(e) => {
            // Autofocus the search input instead of the first list item so
            // the user can start typing immediately.
            e.preventDefault()
            searchInputRef.current?.focus()
          }}
        >
          <div className="relative border-b border-border">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${itemNounPlural}…`}
              className="h-9 rounded-none border-0 pl-8 pr-8 text-sm focus-visible:ring-0"
              aria-label={`Search ${itemNounPlural}`}
            />
            {query && (
              <button
                type="button"
                onClick={() => {
                  setQuery("")
                  searchInputRef.current?.focus()
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <XIcon className="size-3.5" />
              </button>
            )}
          </div>
          <div className="max-h-[320px] overflow-y-auto py-1">
            {options.length === 0 ? (
              <p className="px-3 py-4 text-sm text-muted-foreground">
                No {itemNounPlural} available.
              </p>
            ) : filteredOptions.length === 0 ? (
              <p className="px-3 py-4 text-sm text-muted-foreground">
                No {itemNounPlural} match &ldquo;{query}&rdquo;.
              </p>
            ) : (
              (["partners", "assessments"] as const).map((account) => {
                const items = optionsByAccount[account]
                if (items.length === 0) return null
                return (
                  <div key={account} className="py-1">
                    <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {account === "partners"
                        ? "Partners account"
                        : "Assessments account"}
                    </p>
                    {items.map((opt) => {
                      const key = selectionKey(opt.account, opt.id)
                      const selected = selectedKeys.has(key)
                      return (
                        <button
                          key={key}
                          type="button"
                          onClick={() => toggle(opt)}
                          className={cn(
                            "flex w-full items-start gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                            selected && "bg-accent/40",
                          )}
                        >
                          <span
                            className={cn(
                              "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border",
                              selected
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-border",
                            )}
                          >
                            {selected && <CheckIcon className="size-3" />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate">{opt.label}</span>
                            {opt.sublabel && (
                              <span className="block truncate text-xs text-muted-foreground">
                                {opt.sublabel}
                              </span>
                            )}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                )
              })
            )}
          </div>
        </PopoverContent>
      </Popover>

      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((v) => {
            const key = selectionKey(v.account, v.id)
            const opt = labelByKey.get(key)
            return (
              <span
                key={key}
                className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-muted/50 px-2 py-0.5 text-xs"
              >
                <span className="truncate">{opt?.label ?? v.id}</span>
                <span className="text-[9px] uppercase tracking-wider text-muted-foreground">
                  {v.account === "partners" ? "P" : "A"}
                </span>
                <button
                  type="button"
                  onClick={() => remove(v.account, v.id)}
                  aria-label={`Remove ${opt?.label ?? v.id}`}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <XIcon className="size-3" />
                </button>
              </span>
            )
          })}
        </div>
      )}

      {helperText && (
        <div className="text-xs text-muted-foreground">{helperText}</div>
      )}
    </div>
  )
}
