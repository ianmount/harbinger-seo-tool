"use client"

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { ArrowRight, Loader2, Plus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { MarketPicker } from "@/components/tool/MarketPicker"
import { findToolByPathname } from "@/lib/tool-config"
import type {
  DfsLabsLocation,
  KeywordResearchRun,
  KeywordResearchStatus,
} from "@/lib/types"
import { cn } from "@/lib/utils"

const STATUS_LABEL: Record<KeywordResearchStatus, string> = {
  seeds_review: "Review seeds",
  generating: "Generating…",
  keywords_review: "Review keywords",
  localizing: "Running…",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
}

const STATUS_TONE: Record<KeywordResearchStatus, string> = {
  seeds_review: "bg-info-light text-info-dark",
  generating: "bg-secondary text-ink-2",
  keywords_review: "bg-info-light text-info-dark",
  localizing: "bg-secondary text-ink-2",
  completed: "bg-[#0F6E56] text-white",
  failed: "bg-red-100 text-red-700",
  cancelled: "bg-secondary text-ink-3",
}

function ChipInput({
  label,
  helpText,
  placeholder,
  values,
  onChange,
  disabled,
}: {
  label: string
  helpText?: string
  placeholder: string
  values: string[]
  onChange: (next: string[]) => void
  disabled?: boolean
}) {
  const [draft, setDraft] = useState("")
  function commit() {
    const v = draft.trim()
    if (!v) return
    if (!values.some((x) => x.toLowerCase() === v.toLowerCase())) {
      onChange([...values, v])
    }
    setDraft("")
  }
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    // Only Enter commits — NOT comma, so "Atlanta, GA" can be typed whole.
    if (e.key === "Enter") {
      e.preventDefault()
      commit()
    } else if (e.key === "Backspace" && !draft && values.length > 0) {
      onChange(values.slice(0, -1))
    }
  }
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-line bg-background px-2 py-1.5">
        {values.map((v) => (
          <span
            key={v}
            className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-0.5 text-[12px] text-foreground"
          >
            {v}
            <button
              type="button"
              onClick={() => onChange(values.filter((x) => x !== v))}
              aria-label={`Remove ${v}`}
              className="text-ink-3 hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={commit}
          placeholder={values.length === 0 ? placeholder : ""}
          disabled={disabled}
          className="min-w-[140px] flex-1 bg-transparent px-1 py-0.5 text-[13px] outline-none placeholder:text-ink-3"
        />
      </div>
      {helpText ? (
        <p className="font-mono text-[10.5px] text-ink-3">{helpText}</p>
      ) : null}
    </div>
  )
}

export default function KeywordResearchLauncher() {
  const tool = findToolByPathname("/keywords/research")!
  const router = useRouter()

  const [domain, setDomain] = useState("")
  const [services, setServices] = useState<string[]>([])
  const [cityLocations, setCityLocations] = useState<DfsLabsLocation[]>([])
  const [cityPicker, setCityPicker] = useState<DfsLabsLocation | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [depth, setDepth] = useState("100")
  const [planSize, setPlanSize] = useState("400")

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [runs, setRuns] = useState<KeywordResearchRun[] | null>(null)
  const loadedRef = useRef(false)

  useEffect(() => {
    if (loadedRef.current) return
    loadedRef.current = true
    fetch("/api/keywords/research/runs")
      .then((r) => (r.ok ? r.json() : { runs: [] }))
      .then((d) => setRuns(d.runs ?? []))
      .catch(() => setRuns([]))
  }, [])

  function addCity() {
    if (!cityPicker) return
    if (
      !cityLocations.some((c) => c.location_code === cityPicker.location_code)
    ) {
      setCityLocations((prev) => [...prev, cityPicker])
    }
    setCityPicker(null)
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!domain.trim()) return setError("Enter a domain.")
    if (services.length === 0) return setError("Add at least one service.")
    if (cityLocations.length === 0)
      return setError("Add at least one target city.")

    setSubmitting(true)
    try {
      const res = await fetch("/api/keywords/research/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: domain.trim(),
          services,
          cities: cityLocations.map((c) => ({
            location_code: c.location_code,
            location_name: c.location_name,
          })),
          depth: Number(depth) || 100,
          targetPlanSize: Number(planSize) || 400,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? `Request failed (${res.status})`)
        return
      }
      router.push(`/keywords/research/${data.run.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-6">
      <header className="space-y-1.5">
        <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink-3">
          Keywords
        </p>
        <h1 className="font-sans text-[24px] font-extrabold tracking-[-0.015em] text-foreground">
          {tool.label}
        </h1>
        <p className="max-w-3xl font-serif text-[13.5px] text-ink-2">
          {tool.description}
        </p>
      </header>

      <div className="rounded-lg border border-line bg-card px-5 py-5">
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="domain">Target domain</Label>
            <Input
              id="domain"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="hiremrright.com"
              disabled={submitting}
            />
            <p className="font-mono text-[10.5px] text-ink-3">
              No https:// or www. Used to check current rank per city.
            </p>
          </div>

          <ChipInput
            label="Services"
            placeholder="Type a service and press Enter (e.g. pool cleaning)"
            helpText="However the business phrases them — Claude turns these into search-aligned seeds you approve."
            values={services}
            onChange={setServices}
            disabled={submitting}
          />

          <div className="space-y-2">
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[260px] flex-1">
                <MarketPicker
                  value={cityPicker}
                  onChange={setCityPicker}
                  label="Target cities"
                  inputId="city-picker"
                  disabled={submitting}
                  helpText="Search and pick a real DataForSEO city (one CSV per city). Picking from the list keeps the run synced to the exact location code."
                />
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={addCity}
                disabled={!cityPicker || submitting}
              >
                <Plus className="mr-1 h-3.5 w-3.5" />
                Add city
              </Button>
            </div>
            {cityLocations.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {cityLocations.map((c) => (
                  <span
                    key={c.location_code}
                    className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-0.5 text-[12px]"
                  >
                    {c.location_name}
                    <button
                      type="button"
                      onClick={() =>
                        setCityLocations((prev) =>
                          prev.filter(
                            (x) => x.location_code !== c.location_code,
                          ),
                        )
                      }
                      aria-label={`Remove ${c.location_name}`}
                      className="text-ink-3 hover:text-foreground"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
          </div>

          <div className="border-t border-dashed border-line pt-3">
            <button
              type="button"
              onClick={() => setShowAdvanced((s) => !s)}
              className="text-[12px] font-medium text-ink-2 hover:text-foreground"
            >
              {showAdvanced ? "− Hide" : "+ Show"} advanced settings
            </button>
            {showAdvanced ? (
              <div className="mt-3 flex flex-wrap gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="depth">Depth (per seed)</Label>
                  <Input
                    id="depth"
                    value={depth}
                    onChange={(e) => setDepth(e.target.value.replace(/[^\d]/g, ""))}
                    className="w-28"
                    inputMode="numeric"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="plan">Target plan size</Label>
                  <Input
                    id="plan"
                    value={planSize}
                    onChange={(e) => setPlanSize(e.target.value.replace(/[^\d]/g, ""))}
                    className="w-28"
                    inputMode="numeric"
                  />
                </div>
              </div>
            ) : null}
          </div>

          {error ? (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
              {error}
            </div>
          ) : null}

          <Button type="submit" disabled={submitting}>
            {submitting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Plus className="mr-2 h-4 w-4" />
            )}
            Start research run
          </Button>
        </form>
      </div>

      {/* Existing runs */}
      <div className="rounded-lg border border-line bg-card px-5 py-4">
        <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink-3">
          Your recent runs
        </p>
        {runs == null ? (
          <p className="mt-3 text-[13px] text-ink-3">Loading…</p>
        ) : runs.length === 0 ? (
          <p className="mt-3 text-[13px] text-ink-3">
            No runs yet. Start one above.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-line/60">
            {runs.map((r) => (
              <li key={r.id}>
                <Link
                  href={`/keywords/research/${r.id}`}
                  className="flex items-center justify-between gap-3 py-2.5 hover:bg-muted/30"
                >
                  <div className="min-w-0">
                    <p className="truncate text-[13.5px] font-medium text-foreground">
                      {r.domain}
                    </p>
                    <p className="truncate font-mono text-[11px] text-ink-3">
                      {r.locations.map((l) => l.label).join(" · ") || "—"}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span
                      className={cn(
                        "rounded-md px-2 py-0.5 text-[11px] font-medium",
                        STATUS_TONE[r.status],
                      )}
                    >
                      {STATUS_LABEL[r.status]}
                    </span>
                    <ArrowRight className="h-4 w-4 text-ink-3" />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
