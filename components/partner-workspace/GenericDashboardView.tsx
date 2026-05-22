"use client"

import { useMemo, useState } from "react"
import {
  ResultsTable,
  type ResultColumn,
} from "@/components/tool/ResultsTable"
import { Input } from "@/components/ui/input"

/**
 * Smart fallback renderer for saved tool artifacts that don't have a
 * dedicated `<XxxView/>`. Walks the payload and surfaces it as a real
 * visual dashboard instead of a raw-JSON dump:
 *
 *   • Scalar fields (numbers, short strings, booleans, ISO dates) at
 *     the top level become a KPI grid.
 *   • Array-of-objects fields become tables with auto-detected columns
 *     (union of keys across rows).
 *   • Nested objects become their own labelled section with the same
 *     treatment applied recursively (one level deep).
 *   • Plain string fields ≥ 80 chars or containing newlines become
 *     paragraphs (e.g. saved narrative content).
 *
 * Designed so every newly-saved artifact kind gets something more
 * useful than a JSON tree without having to write a bespoke viewer.
 * Individual kinds can still ship a tailored view by adding a branch
 * to `ArtifactBody` in `app/partners/[id]/artifacts/[artifactId]/page`.
 */

const SKIP_TOP_LEVEL = new Set([
  // Generic metadata fields the save spec adds — already shown by the
  // detail page chrome, so we don't surface them in the body.
  "capturedAt",
])

interface FieldEntry {
  key: string
  value: unknown
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function isArrayOfObjects(v: unknown): v is Record<string, unknown>[] {
  return Array.isArray(v) && v.every((x) => isPlainObject(x))
}

function looksLikeIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}/.test(s) && !Number.isNaN(Date.parse(s))
}

function humanize(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function formatScalar(value: unknown): string {
  if (value == null) return "—"
  if (typeof value === "number") return value.toLocaleString()
  if (typeof value === "boolean") return value ? "Yes" : "No"
  if (typeof value === "string") {
    if (looksLikeIsoDate(value)) {
      const d = new Date(value)
      return Number.isNaN(d.getTime())
        ? value
        : d.toLocaleString(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          })
    }
    return value
  }
  return String(value)
}

function classifyField(value: unknown): "kpi" | "array" | "nested" | "text" | "skip" {
  if (value == null) return "skip"
  if (typeof value === "boolean") return "kpi"
  if (typeof value === "number") return "kpi"
  if (typeof value === "string") {
    if (value.length === 0) return "skip"
    if (value.length >= 80 || /\n/.test(value)) return "text"
    return "kpi"
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "skip"
    if (isArrayOfObjects(value)) return "array"
    // Array of scalars — render as a comma-joined KPI.
    return "kpi"
  }
  if (isPlainObject(value)) return "nested"
  return "skip"
}

function autoColumns(
  rows: Record<string, unknown>[],
): ResultColumn<Record<string, unknown>>[] {
  // Preserve insertion order across the union of keys present in the rows.
  const seen = new Set<string>()
  const keys: string[] = []
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) {
        seen.add(k)
        keys.push(k)
      }
    }
  }
  // Cap to 8 columns to keep tables legible; users can always download CSV.
  const cap = keys.slice(0, 8)
  return cap.map((k) => {
    // Detect if every present value is a number → numeric column.
    let allNumeric = true
    for (const r of rows) {
      const v = r[k]
      if (v == null) continue
      if (typeof v !== "number") {
        allNumeric = false
        break
      }
    }
    return {
      key: k,
      label: humanize(k),
      numeric: allNumeric,
      accessor: (r) => {
        const v = r[k]
        return typeof v === "number" ? v : v == null ? null : String(v)
      },
      format: (r) => {
        const v = r[k]
        if (v == null) return "—"
        if (typeof v === "number") return v.toLocaleString()
        if (typeof v === "string") return v
        if (typeof v === "boolean") return v ? "Yes" : "No"
        return JSON.stringify(v)
      },
    }
  })
}

function entries(data: Record<string, unknown>): FieldEntry[] {
  return Object.entries(data)
    .filter(([k]) => !SKIP_TOP_LEVEL.has(k))
    .map(([key, value]) => ({ key, value }))
}

export function GenericDashboardView({ data }: { data: unknown }) {
  if (!isPlainObject(data)) {
    return (
      <pre className="rounded-lg border border-border bg-muted/30 p-4 text-xs">
        {JSON.stringify(data, null, 2)}
      </pre>
    )
  }
  const all = entries(data)
  const kpis = all.filter((e) => classifyField(e.value) === "kpi")
  const texts = all.filter((e) => classifyField(e.value) === "text")
  const arrays = all.filter((e) => classifyField(e.value) === "array")
  const nested = all.filter((e) => classifyField(e.value) === "nested")

  return (
    <div className="space-y-5">
      {kpis.length > 0 && <KpiGrid entries={kpis} />}
      {texts.map(({ key, value }) => (
        <TextBlock key={key} label={humanize(key)} text={String(value)} />
      ))}
      {arrays.map(({ key, value }) => (
        <ArraySection
          key={key}
          label={humanize(key)}
          rows={value as Record<string, unknown>[]}
        />
      ))}
      {nested.map(({ key, value }) => (
        <NestedSection
          key={key}
          label={humanize(key)}
          value={value as Record<string, unknown>}
        />
      ))}
    </div>
  )
}

function KpiGrid({ entries }: { entries: FieldEntry[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {entries.map(({ key, value }) => (
        <div
          key={key}
          className="rounded-lg border border-border bg-card p-3"
        >
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {humanize(key)}
          </p>
          <p className="mt-1 truncate text-lg font-semibold tabular-nums">
            {Array.isArray(value)
              ? value.map((v) => formatScalar(v)).join(", ")
              : formatScalar(value)}
          </p>
        </div>
      ))}
    </div>
  )
}

function TextBlock({ label, text }: { label: string; text: string }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </h3>
      <div className="whitespace-pre-wrap rounded-lg border border-border bg-card p-4 text-sm leading-relaxed">
        {text}
      </div>
    </section>
  )
}

function ArraySection({
  label,
  rows,
}: {
  label: string
  rows: Record<string, unknown>[]
}) {
  const [query, setQuery] = useState("")
  const cols = useMemo(() => autoColumns(rows), [rows])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) =>
      Object.values(r).some(
        (v) => v != null && String(v).toLowerCase().includes(q),
      ),
    )
  }, [rows, query])

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {label} · {rows.length.toLocaleString()}
        </h3>
        {rows.length > 5 && (
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter…"
            className="h-8 w-[200px] text-sm"
            aria-label={`Filter ${label}`}
          />
        )}
      </div>
      <ResultsTable
        rows={filtered}
        columns={cols}
        filename={label.toLowerCase().replace(/\s+/g, "-")}
      />
    </section>
  )
}

function NestedSection({
  label,
  value,
}: {
  label: string
  value: Record<string, unknown>
}) {
  const all = entries(value)
  const kpis = all.filter((e) => classifyField(e.value) === "kpi")
  const arrays = all.filter((e) => classifyField(e.value) === "array")
  const texts = all.filter((e) => classifyField(e.value) === "text")

  if (kpis.length === 0 && arrays.length === 0 && texts.length === 0)
    return null

  return (
    <section className="rounded-lg border border-border p-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </h3>
      <div className="space-y-4">
        {kpis.length > 0 && <KpiGrid entries={kpis} />}
        {texts.map(({ key, value: v }) => (
          <TextBlock key={key} label={humanize(key)} text={String(v)} />
        ))}
        {arrays.map(({ key, value: v }) => (
          <ArraySection
            key={key}
            label={humanize(key)}
            rows={v as Record<string, unknown>[]}
          />
        ))}
      </div>
    </section>
  )
}
