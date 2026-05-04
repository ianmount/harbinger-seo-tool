"use client"

import { useCallback, useState } from "react"
import ReactMarkdown from "react-markdown"
import { DownloadIcon, PlayIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
import {
  getPartnerDfseoPresets,
  LLM_PLATFORM_OPTIONS,
  type LlmPlatform,
} from "@/lib/dfseo-tools-presets"
import type { Partner } from "@/lib/types"

type CsvOutput = {
  headers: string[]
  rows: (string | number | null)[][]
}

type RunResult = {
  toolId: string
  statusMessage: string
  costUsd: number | null
  outputKind: "md" | "csv"
  markdown?: string
  csv?: CsvOutput
}

type PhaseMap = Record<
  string,
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; result: RunResult }
  | { status: "error"; message: string }
>

function csvEscape(value: unknown): string {
  if (value == null) return ""
  const s = String(value)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function csvToString(csv: CsvOutput): string {
  const lines = [csv.headers.map(csvEscape).join(",")]
  for (const row of csv.rows) lines.push(row.map(csvEscape).join(","))
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

function CsvResultTable({ csv }: { csv: CsvOutput }) {
  const PAGE = 50
  const [page, setPage] = useState(0)
  const totalPages = Math.max(1, Math.ceil(csv.rows.length / PAGE))
  const visible = csv.rows.slice(page * PAGE, page * PAGE + PAGE)

  return (
    <div className="space-y-2">
      <div className="max-h-72 overflow-auto rounded-md border border-border text-xs">
        <Table>
          <TableHeader>
            <TableRow>
              {csv.headers.map((h) => (
                <TableHead key={h} className="whitespace-nowrap text-xs">
                  {h}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((row, i) => (
              <TableRow key={i}>
                {row.map((cell, j) => (
                  <TableCell key={j} className="max-w-[200px] truncate text-xs">
                    {cell ?? ""}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {totalPages > 1 && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2"
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
          >
            Prev
          </Button>
          <span>
            Page {page + 1} / {totalPages} ({csv.rows.length} rows)
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2"
            disabled={page >= totalPages - 1}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  )
}

function MdResult({ markdown }: { markdown: string }) {
  return (
    <article className="max-h-96 overflow-auto rounded-md border border-border bg-muted/30 p-3 text-sm">
      <ReactMarkdown
        components={{
          h1: ({ children }) => <h1 className="mb-1 text-base font-bold">{children}</h1>,
          h2: ({ children }) => <h2 className="mt-3 mb-1 text-sm font-semibold">{children}</h2>,
          h3: ({ children }) => <h3 className="mt-2 mb-0.5 text-xs font-semibold">{children}</h3>,
          p: ({ children }) => <p className="my-1 text-xs leading-relaxed">{children}</p>,
          ul: ({ children }) => <ul className="my-1 list-disc pl-4 text-xs">{children}</ul>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          code: ({ children }) => (
            <code className="rounded bg-muted px-0.5 font-mono text-[0.8em]">
              {children}
            </code>
          ),
        }}
      >
        {markdown}
      </ReactMarkdown>
    </article>
  )
}

export function DfseoActionsPanel({ partner }: { partner: Partner }) {
  const presets = getPartnerDfseoPresets(partner)
  const [phases, setPhases] = useState<PhaseMap>(() =>
    Object.fromEntries(presets.map((p) => [p.toolId, { status: "idle" }])),
  )
  const [llmPlatform, setLlmPlatform] = useState<LlmPlatform>("google")

  const run = useCallback(
    async (toolId: string) => {
      const preset = presets.find((p) => p.toolId === toolId)
      if (!preset) return

      const params =
        toolId === "ai-llm-mentions-search"
          ? { ...preset.params, platform: llmPlatform }
          : preset.params

      setPhases((prev) => ({ ...prev, [toolId]: { status: "running" } }))
      try {
        const res = await fetch("/api/dataforseo/tools", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ toolId, params }),
        })
        const body = (await res.json()) as RunResult & { error?: string }
        if (!res.ok || body.error) {
          throw new Error(body.error ?? `HTTP ${res.status}`)
        }
        setPhases((prev) => ({
          ...prev,
          [toolId]: { status: "done", result: body },
        }))
      } catch (err) {
        setPhases((prev) => ({
          ...prev,
          [toolId]: {
            status: "error",
            message: err instanceof Error ? err.message : "Failed",
          },
        }))
      }
    },
    [presets, llmPlatform],
  )

  return (
    <section className="space-y-4">
      <h3 className="font-sans text-xs font-extrabold uppercase tracking-[0.18em] text-muted-foreground">
        DataForSEO Actions
      </h3>

      <div className="space-y-4">
        {presets.map((preset) => {
          const phase = phases[preset.toolId] ?? { status: "idle" }
          const isLlm = preset.toolId === "ai-llm-mentions-search"

          return (
            <div
              key={preset.toolId}
              className="rounded-lg border border-border p-3 space-y-3"
            >
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <p className="text-sm font-semibold">{preset.label}</p>
                </div>

                {isLlm && (
                  <Select
                    value={llmPlatform}
                    onValueChange={(v) => setLlmPlatform(v as LlmPlatform)}
                  >
                    <SelectTrigger className="h-7 w-[170px] text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LLM_PLATFORM_OPTIONS.map((opt) => (
                        <SelectItem
                          key={opt.value}
                          value={opt.value}
                          className="text-xs"
                        >
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}

                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-3 text-xs"
                  disabled={phase.status === "running"}
                  onClick={() => run(preset.toolId)}
                >
                  <PlayIcon className="mr-1.5 size-3" />
                  {phase.status === "running" ? "Running…" : "Run"}
                </Button>

                {phase.status === "done" && phase.result.csv && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2"
                    onClick={() =>
                      downloadBlob(
                        csvToString(phase.result.csv!),
                        `${preset.toolId}-${partner.name.toLowerCase().replace(/\s+/g, "-")}.csv`,
                        "text/csv",
                      )
                    }
                  >
                    <DownloadIcon className="size-3.5" />
                  </Button>
                )}

                {phase.status === "done" && phase.result.costUsd !== null && (
                  <Badge variant="secondary" className="text-[10px]">
                    ${phase.result.costUsd.toFixed(4)}
                  </Badge>
                )}
              </div>

              {phase.status === "error" && (
                <p className="text-xs text-destructive">{phase.message}</p>
              )}

              {phase.status === "done" &&
                phase.result.outputKind === "csv" &&
                phase.result.csv && (
                  <CsvResultTable csv={phase.result.csv} />
                )}

              {phase.status === "done" &&
                phase.result.outputKind === "md" &&
                phase.result.markdown && (
                  <MdResult markdown={phase.result.markdown} />
                )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
