"use client"

import { useCallback, useMemo, useState } from "react"
import { DownloadIcon } from "lucide-react"
import ReactMarkdown from "react-markdown"
import { LocationAutocomplete } from "@/components/LocationAutocomplete"
import { PageHeader } from "@/components/PageHeader"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  TOOL_SPECS,
  groupedToolSpecs,
  type ToolField,
  type ToolFieldOption,
  type ToolSpec,
} from "@/lib/dfseo-tools"
import type { DfsLabsLocation } from "@/lib/types"

type CsvOutput = {
  headers: string[]
  rows: (string | number | null)[][]
}

type RunResult = {
  endpoint: string
  statusMessage: string
  costUsd: number | null
  outputKind: "md" | "csv"
  markdown?: string
  csv?: CsvOutput
}

type RunPhase =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; result: RunResult }
  | { status: "error"; message: string }

const DEFAULT_TOOL_ID = "labs-keyword-ideas"

const DEFAULT_LOCATION: DfsLabsLocation = {
  location_code: 2840,
  location_name: "United States",
  location_code_parent: null,
  country_iso_code: "US",
  location_type: "Country",
}

function defaultParamsFor(spec: ToolSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of spec.fields) {
    if (f.default !== undefined) out[f.name] = f.default
  }
  return out
}

function defaultLocationDisplayFor(
  spec: ToolSpec,
): Record<string, DfsLabsLocation> {
  const out: Record<string, DfsLabsLocation> = {}
  for (const f of spec.fields) {
    if (f.kind === "location" && f.default === DEFAULT_LOCATION.location_code) {
      out[f.name] = DEFAULT_LOCATION
    }
  }
  return out
}

function csvEscape(value: unknown): string {
  if (value == null) return ""
  const s = String(value)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function csvToString(csv: CsvOutput): string {
  const lines = [csv.headers.map(csvEscape).join(",")]
  for (const row of csv.rows) {
    lines.push(row.map(csvEscape).join(","))
  }
  return lines.join("\n")
}

function downloadBlob(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export default function DataForSEOToolsPage() {
  const [toolId, setToolId] = useState<string>(DEFAULT_TOOL_ID)
  const spec = useMemo(
    () => TOOL_SPECS.find((t) => t.id === toolId) ?? TOOL_SPECS[0],
    [toolId],
  )
  const [params, setParams] = useState<Record<string, unknown>>(
    defaultParamsFor(spec),
  )
  const [locationDisplay, setLocationDisplay] = useState<
    Record<string, DfsLabsLocation>
  >(defaultLocationDisplayFor(spec))
  const [phase, setPhase] = useState<RunPhase>({ status: "idle" })

  const handleSelectTool = useCallback((id: string) => {
    setToolId(id)
    const next = TOOL_SPECS.find((t) => t.id === id)
    if (next) {
      setParams(defaultParamsFor(next))
      setLocationDisplay(defaultLocationDisplayFor(next))
    }
    setPhase({ status: "idle" })
  }, [])

  const setField = useCallback(
    (name: string, value: unknown) => {
      setParams((prev) => ({ ...prev, [name]: value }))
    },
    [],
  )

  const setLocationField = useCallback(
    (name: string, loc: DfsLabsLocation | undefined) => {
      setParams((prev) => ({
        ...prev,
        [name]: loc ? loc.location_code : undefined,
      }))
      setLocationDisplay((prev) => {
        const next = { ...prev }
        if (loc) next[name] = loc
        else delete next[name]
        return next
      })
    },
    [],
  )

  const handleRun = useCallback(async () => {
    setPhase({ status: "running" })
    try {
      const response = await fetch("/api/dataforseo/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolId, params }),
      })
      const body = (await response.json().catch(() => ({}))) as
        | RunResult
        | { error?: string }
      if (!response.ok) {
        const message =
          (body as { error?: string }).error ??
          `Request failed (${response.status})`
        setPhase({ status: "error", message })
        return
      }
      setPhase({ status: "done", result: body as RunResult })
    } catch (err) {
      setPhase({
        status: "error",
        message: err instanceof Error ? err.message : "Network error",
      })
    }
  }, [toolId, params])

  const grouped = useMemo(() => groupedToolSpecs(), [])
  const running = phase.status === "running"

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Tool / DataForSEO APIs"
        title="DataForSEO APIs"
        tail="— one-off live calls."
        subtitle={
          <>
            Pick a{" "}
            <b className="font-sans font-extrabold not-italic text-foreground">
              DataForSEO
            </b>{" "}
            live endpoint, fill in its parameters, and view the result inline as
            either a Markdown report or a CSV table — both can be downloaded.
            OnPage crawl tasks are out of scope here.
          </>
        }
      />

      <section className="space-y-4 rounded-lg border p-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="tool-picker">Endpoint</Label>
          <select
            id="tool-picker"
            value={toolId}
            onChange={(e) => handleSelectTool(e.target.value)}
            disabled={running}
            className="h-9 w-full max-w-[420px] rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {grouped.map((g) => (
              <optgroup key={g.category} label={g.category}>
                {g.tools.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            <span className="font-mono text-foreground">{spec.endpoint}</span> ·{" "}
            {spec.description} Output: <strong>{spec.output.toUpperCase()}</strong>.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {spec.fields.map((field) => (
            <FieldRenderer
              key={field.name}
              field={field}
              value={params[field.name]}
              locationDisplay={
                field.kind === "location"
                  ? locationDisplay[field.name]
                  : undefined
              }
              onChange={(v) => setField(field.name, v)}
              onLocationChange={(loc) => setLocationField(field.name, loc)}
              disabled={running}
            />
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={handleRun} disabled={running}>
            {running ? "Running…" : "Run"}
          </Button>
          {phase.status === "done" ? (
            <span className="text-xs text-muted-foreground">
              {phase.result.statusMessage}
              {phase.result.costUsd != null
                ? ` · DFS cost $${phase.result.costUsd.toFixed(4)}`
                : ""}
            </span>
          ) : null}
        </div>
      </section>

      {phase.status === "error" ? (
        <p
          className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
          role="alert"
        >
          {phase.message}
        </p>
      ) : null}

      {phase.status === "done" ? (
        <ResultPanel result={phase.result} toolId={toolId} />
      ) : null}
    </div>
  )
}

function FieldRenderer({
  field,
  value,
  locationDisplay,
  onChange,
  onLocationChange,
  disabled,
}: {
  field: ToolField
  value: unknown
  locationDisplay?: DfsLabsLocation
  onChange: (v: unknown) => void
  onLocationChange: (loc: DfsLabsLocation | undefined) => void
  disabled?: boolean
}) {
  const id = `field-${field.name}`
  const help = field.help ? (
    <p className="text-xs text-muted-foreground">{field.help}</p>
  ) : null
  const labelEl = (
    <Label htmlFor={id}>
      {field.label}
      {field.required ? <span className="text-destructive"> *</span> : null}
    </Label>
  )

  switch (field.kind) {
    case "text":
      return (
        <div className="flex flex-col gap-1.5">
          {labelEl}
          <Input
            id={id}
            type="text"
            value={typeof value === "string" ? value : ""}
            placeholder={field.placeholder}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
          />
          {help}
        </div>
      )
    case "textarea":
      return (
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          {labelEl}
          <Textarea
            id={id}
            value={typeof value === "string" ? value : ""}
            placeholder={field.placeholder}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            className="min-h-[100px]"
          />
          {help}
        </div>
      )
    case "number":
      return (
        <div className="flex flex-col gap-1.5">
          {labelEl}
          <Input
            id={id}
            type="number"
            value={typeof value === "number" ? value : ""}
            min={field.min}
            max={field.max}
            onChange={(e) => {
              const v = e.target.value
              onChange(v === "" ? undefined : Number(v))
            }}
            disabled={disabled}
          />
          {help}
        </div>
      )
    case "boolean":
      return (
        <label
          className="flex items-start gap-2 sm:col-span-2"
          htmlFor={id}
        >
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
            disabled={disabled}
            className="mt-1"
          />
          <span className="flex flex-col gap-0.5">
            <span className="text-sm font-medium leading-none">
              {field.label}
            </span>
            {help}
          </span>
        </label>
      )
    case "select":
      return (
        <div className="flex flex-col gap-1.5">
          {labelEl}
          <select
            id={id}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {(field.options ?? []).map((o: ToolFieldOption) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {help}
        </div>
      )
    case "string-array":
      return (
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          {labelEl}
          <Textarea
            id={id}
            value={
              Array.isArray(value)
                ? (value as unknown[]).map(String).join("\n")
                : typeof value === "string"
                  ? value
                  : ""
            }
            placeholder={field.placeholder}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            className="min-h-[80px]"
          />
          {help}
        </div>
      )
    case "location": {
      const selected = locationDisplay ? [locationDisplay] : []
      return (
        <div className="sm:col-span-2">
          <LocationAutocomplete
            selected={selected}
            onAdd={(loc) => onLocationChange(loc)}
            onRemove={() => onLocationChange(undefined)}
            disabled={disabled}
            label={field.label}
            helpText={field.help}
          />
        </div>
      )
    }
  }
}

function ResultPanel({
  result,
  toolId,
}: {
  result: RunResult
  toolId: string
}) {
  const stamp = new Date().toISOString().slice(0, 10)
  const baseSlug = toolId

  if (result.outputKind === "csv" && result.csv) {
    const csvText = csvToString(result.csv)
    return (
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">
            CSV result · {result.csv.rows.length} rows
          </h2>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => downloadBlob(csvText, `${baseSlug}-${stamp}.csv`, "text/csv")}
            disabled={result.csv.rows.length === 0}
          >
            <DownloadIcon className="mr-2 size-4" />
            Download CSV
          </Button>
        </div>
        <CsvTable csv={result.csv} />
      </section>
    )
  }

  const md = result.markdown ?? ""
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium text-muted-foreground">
          Markdown report
        </h2>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={() => downloadBlob(md, `${baseSlug}-${stamp}.md`, "text/markdown")}
          disabled={md.length === 0}
        >
          <DownloadIcon className="mr-2 size-4" />
          Download MD
        </Button>
      </div>
      <article className="rounded-lg border bg-card p-6">
        <ReactMarkdown
          components={{
            h1: ({ children }) => (
              <h1 className="mb-2 text-2xl font-semibold">{children}</h1>
            ),
            h2: ({ children }) => (
              <h2 className="mt-6 mb-2 border-b pb-1 text-lg font-semibold">
                {children}
              </h2>
            ),
            h3: ({ children }) => (
              <h3 className="mt-4 mb-1 text-base font-semibold">{children}</h3>
            ),
            p: ({ children }) => (
              <p className="my-2 text-sm leading-relaxed">{children}</p>
            ),
            ul: ({ children }) => (
              <ul className="my-2 list-disc space-y-1 pl-5 text-sm">
                {children}
              </ul>
            ),
            ol: ({ children }) => (
              <ol className="my-2 list-decimal space-y-1 pl-5 text-sm">
                {children}
              </ol>
            ),
            li: ({ children }) => <li className="leading-relaxed">{children}</li>,
            strong: ({ children }) => (
              <strong className="font-semibold">{children}</strong>
            ),
            code: ({ children }) => (
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
                {children}
              </code>
            ),
            table: ({ children }) => (
              <div className="my-3 overflow-x-auto">
                <table className="w-full text-xs">{children}</table>
              </div>
            ),
            th: ({ children }) => (
              <th className="border-b px-2 py-1 text-left font-medium">
                {children}
              </th>
            ),
            td: ({ children }) => (
              <td className="border-b px-2 py-1 align-top">{children}</td>
            ),
          }}
        >
          {md}
        </ReactMarkdown>
      </article>
    </section>
  )
}

function CsvTable({ csv }: { csv: CsvOutput }) {
  const display = csv.rows.slice(0, 200)
  return (
    <div className="rounded-lg border overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            {csv.headers.map((h) => (
              <TableHead key={h} className="whitespace-nowrap">
                {h}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {display.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={csv.headers.length || 1}
                className="text-center text-sm text-muted-foreground"
              >
                No rows.
              </TableCell>
            </TableRow>
          ) : (
            display.map((row, i) => (
              <TableRow key={i}>
                {row.map((cell, j) => (
                  <TableCell key={j} className="align-top text-xs">
                    {cell == null
                      ? ""
                      : typeof cell === "number"
                        ? cell.toLocaleString()
                        : String(cell).slice(0, 240)}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      {csv.rows.length > display.length ? (
        <p className="px-3 py-2 text-xs text-muted-foreground border-t">
          Showing first {display.length} of {csv.rows.length.toLocaleString()}{" "}
          rows. Download CSV for the full set.
        </p>
      ) : null}
    </div>
  )
}
