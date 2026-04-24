"use client"

import { useCallback, useMemo, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import { CheckIcon, CopyIcon, DownloadIcon, UploadIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useSelectedPartner } from "@/lib/use-selected-partner"
import type { Partner } from "@/lib/types"

type ParsedKeyword = {
  keyword: string
  cluster: string
  fitScore?: number
  intent?: "informational" | "commercial" | "transactional" | "navigational"
  recommendation?: "target" | "monitor" | "skip"
  search_volume?: number
  keyword_difficulty?: number
  cpc?: number
  competition_level?: "HIGH" | "MEDIUM" | "LOW"
}

type ParseResult =
  | { status: "empty" }
  | { status: "ok"; keywords: ParsedKeyword[]; clusters: number; format: "csv" | "json" }
  | { status: "error"; message: string }

type GenerationPhase =
  | { status: "idle" }
  | { status: "generating" }
  | {
      status: "done"
      strategy: string
      usage: {
        inputTokens: number
        outputTokens: number
        estimatedCostUsd: number
      }
      partnerName: string
    }
  | { status: "error"; message: string }

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

/**
 * Parse a single CSV row honoring double-quote escaping ("" → "). Returns
 * the cells in order. Handles embedded commas and newlines inside quoted
 * fields. Assumes a single row (no multiline values split across rows) —
 * sufficient for the Keyword Research CSV export, which emits flat rows.
 */
function parseCsvRow(line: string): string[] {
  const cells: string[] = []
  let cur = ""
  let inQuotes = false
  let i = 0
  while (i < line.length) {
    const c = line[i]
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      cur += c
      i++
      continue
    }
    if (c === '"') {
      inQuotes = true
      i++
      continue
    }
    if (c === ",") {
      cells.push(cur)
      cur = ""
      i++
      continue
    }
    cur += c
    i++
  }
  cells.push(cur)
  return cells
}

/**
 * Parses CSV or JSON keyword lists. Expects the CSV header row to use the
 * same column names produced by the Keyword Research tab's export: "Keyword",
 * "Cluster", "Volume", "Difficulty", "Fit Score", "Intent", "Recommendation",
 * "CPC", "Competition".
 *
 * JSON accepts either a raw ScoredKeyword[] or an array of cluster objects
 * `{ name, keywords: [...] }` (the shape returned by /api/claude/keywords),
 * flattening to a single keyword list either way.
 */
function parseKeywordInput(input: string): ParseResult {
  const trimmed = input.trim()
  if (!trimmed) return { status: "empty" }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let data: unknown
    try {
      data = JSON.parse(trimmed)
    } catch (err) {
      return {
        status: "error",
        message: `JSON parse failed: ${err instanceof Error ? err.message : "unknown"}`,
      }
    }
    const flat = flattenJsonKeywords(data)
    if (flat.length === 0) {
      return {
        status: "error",
        message:
          "JSON parsed but no keywords found. Expected an array of scored keywords or { clusters: [{ name, keywords: [...] }] }.",
      }
    }
    const clusters = new Set(flat.map((k) => k.cluster)).size
    return { status: "ok", keywords: flat, clusters, format: "json" }
  }

  // Fallback: treat as CSV with header row.
  const lines = trimmed.split(/\r?\n/).filter((l) => l.length > 0)
  if (lines.length < 2) {
    return {
      status: "error",
      message:
        "Need at least a header row and one keyword row. Paste the CSV export from the Keyword Research tab.",
    }
  }

  const header = parseCsvRow(lines[0]).map((h) => h.trim().toLowerCase())
  const keywordIdx = header.indexOf("keyword")
  if (keywordIdx === -1) {
    return {
      status: "error",
      message: `CSV header must include a "Keyword" column. Got: ${header.join(", ")}`,
    }
  }
  const clusterIdx = header.indexOf("cluster")
  const volumeIdx = header.indexOf("volume")
  const difficultyIdx = header.indexOf("difficulty")
  const fitIdx = header.findIndex((h) => h === "fit score" || h === "fitscore")
  const intentIdx = header.indexOf("intent")
  const recIdx = header.indexOf("recommendation")
  const cpcIdx = header.indexOf("cpc")
  const competitionIdx = header.indexOf("competition")

  const keywords: ParsedKeyword[] = []
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvRow(lines[i])
    const keyword = cells[keywordIdx]?.trim()
    if (!keyword) continue
    const parsed: ParsedKeyword = {
      keyword,
      cluster: (clusterIdx >= 0 && cells[clusterIdx]?.trim()) || "Uncategorized",
    }
    if (volumeIdx >= 0) {
      const n = toNumber(cells[volumeIdx])
      if (n != null) parsed.search_volume = n
    }
    if (difficultyIdx >= 0) {
      const n = toNumber(cells[difficultyIdx])
      if (n != null) parsed.keyword_difficulty = n
    }
    if (fitIdx >= 0) {
      const n = toNumber(cells[fitIdx])
      if (n != null) parsed.fitScore = n
    }
    if (intentIdx >= 0) {
      const v = cells[intentIdx]?.trim().toLowerCase()
      if (
        v === "informational" ||
        v === "commercial" ||
        v === "transactional" ||
        v === "navigational"
      ) {
        parsed.intent = v
      }
    }
    if (recIdx >= 0) {
      const v = cells[recIdx]?.trim().toLowerCase()
      if (v === "target" || v === "monitor" || v === "skip") {
        parsed.recommendation = v
      }
    }
    if (cpcIdx >= 0) {
      const n = toNumber(cells[cpcIdx])
      if (n != null) parsed.cpc = n
    }
    if (competitionIdx >= 0) {
      const v = cells[competitionIdx]?.trim().toUpperCase()
      if (v === "HIGH" || v === "MEDIUM" || v === "LOW") {
        parsed.competition_level = v
      }
    }
    keywords.push(parsed)
  }
  if (keywords.length === 0) {
    return {
      status: "error",
      message: "CSV had no usable keyword rows.",
    }
  }
  const clusters = new Set(keywords.map((k) => k.cluster)).size
  return { status: "ok", keywords, clusters, format: "csv" }
}

function toNumber(cell: string | undefined): number | undefined {
  if (cell == null) return undefined
  const trimmed = cell.trim()
  if (!trimmed) return undefined
  const n = Number(trimmed.replace(/,/g, ""))
  return Number.isFinite(n) ? n : undefined
}

function flattenJsonKeywords(data: unknown): ParsedKeyword[] {
  const out: ParsedKeyword[] = []
  const pushRaw = (raw: unknown, fallbackCluster?: string) => {
    if (!raw || typeof raw !== "object") return
    const obj = raw as Record<string, unknown>
    const keyword = typeof obj.keyword === "string" ? obj.keyword.trim() : ""
    if (!keyword) return
    const kw: ParsedKeyword = {
      keyword,
      cluster:
        typeof obj.cluster === "string" && obj.cluster.trim()
          ? obj.cluster.trim()
          : fallbackCluster ?? "Uncategorized",
    }
    if (typeof obj.fitScore === "number") kw.fitScore = obj.fitScore
    if (
      obj.intent === "informational" ||
      obj.intent === "commercial" ||
      obj.intent === "transactional" ||
      obj.intent === "navigational"
    ) {
      kw.intent = obj.intent
    }
    if (
      obj.recommendation === "target" ||
      obj.recommendation === "monitor" ||
      obj.recommendation === "skip"
    ) {
      kw.recommendation = obj.recommendation
    }
    if (typeof obj.search_volume === "number") kw.search_volume = obj.search_volume
    if (typeof obj.keyword_difficulty === "number")
      kw.keyword_difficulty = obj.keyword_difficulty
    if (typeof obj.cpc === "number") kw.cpc = obj.cpc
    if (
      obj.competition_level === "HIGH" ||
      obj.competition_level === "MEDIUM" ||
      obj.competition_level === "LOW"
    ) {
      kw.competition_level = obj.competition_level
    }
    out.push(kw)
  }

  if (Array.isArray(data)) {
    // Two shapes: ScoredKeyword[] OR KeywordCluster[] { name, keywords: [] }.
    for (const entry of data) {
      if (entry && typeof entry === "object") {
        const obj = entry as Record<string, unknown>
        if (Array.isArray(obj.keywords) && typeof obj.name === "string") {
          for (const kw of obj.keywords) pushRaw(kw, obj.name)
        } else {
          pushRaw(entry)
        }
      }
    }
  } else if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>
    if (Array.isArray(obj.keywords)) {
      for (const kw of obj.keywords) pushRaw(kw)
    } else if (Array.isArray(obj.clusters)) {
      for (const c of obj.clusters) {
        if (c && typeof c === "object") {
          const co = c as Record<string, unknown>
          if (Array.isArray(co.keywords)) {
            const name = typeof co.name === "string" ? co.name : undefined
            for (const kw of co.keywords) pushRaw(kw, name)
          }
        }
      }
    }
  }

  return out
}

function formatCurrency(n: number): string {
  // Sub-cent values still show a few decimals so low-cost strategy runs
  // don't read as "$0.00".
  if (n < 0.01) return `$${n.toFixed(4)}`
  return `$${n.toFixed(3)}`
}

export default function StrategyPage() {
  const { partner, loading: partnerLoading, error: partnerError } =
    useSelectedPartner()
  const [input, setInput] = useState("")
  const [phase, setPhase] = useState<GenerationPhase>({ status: "idle" })
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle")
  const fileInputRef = useRef<HTMLInputElement>(null)

  const parsed = useMemo(() => parseKeywordInput(input), [input])

  const canGenerate =
    !!partner &&
    parsed.status === "ok" &&
    phase.status !== "generating"

  const handleFileUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = (ev) => {
        const text = String(ev.target?.result ?? "")
        setInput(text)
      }
      reader.onerror = () => {
        setPhase({
          status: "error",
          message: `Failed to read file: ${file.name}`,
        })
      }
      reader.readAsText(file)
      // Allow re-selecting the same file later.
      e.target.value = ""
    },
    [],
  )

  const handleGenerate = useCallback(async () => {
    if (!partner || parsed.status !== "ok") return
    setPhase({ status: "generating" })
    try {
      const response = await fetch("/api/claude/strategy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          partner,
          keywords: parsed.keywords,
        }),
      })
      const body = (await response.json().catch(() => ({}))) as {
        strategy?: string
        usage?: {
          inputTokens: number
          outputTokens: number
          estimatedCostUsd: number
        }
        error?: string
      }
      if (!response.ok || !body.strategy || !body.usage) {
        throw new Error(
          body.error ?? `Claude request failed (${response.status})`,
        )
      }
      setPhase({
        status: "done",
        strategy: body.strategy,
        usage: body.usage,
        partnerName: partner.name,
      })
    } catch (err) {
      setPhase({
        status: "error",
        message:
          err instanceof Error ? err.message : "Failed to generate strategy",
      })
    }
  }, [partner, parsed])

  const handleCopy = useCallback(async () => {
    if (phase.status !== "done") return
    try {
      await navigator.clipboard.writeText(phase.strategy)
      setCopyState("copied")
      setTimeout(() => setCopyState("idle"), 1500)
    } catch {
      // Surface a short-lived error via the copy button state; avoids
      // wiring a full toast system for this single button.
      setCopyState("idle")
    }
  }, [phase])

  const handleDownload = useCallback(() => {
    if (phase.status !== "done") return
    const blob = new Blob([phase.strategy], {
      type: "text/markdown;charset=utf-8",
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    const stamp = new Date().toISOString().slice(0, 10)
    a.href = url
    a.download = `${slugify(phase.partnerName) || "partner"}-strategy-${stamp}.md`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, [phase])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Strategy</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Turn an approved keyword list into a 6-month SEO strategy document —
          page roadmap, FAQ banks, internal linking plan, and month-by-month
          priorities.
        </p>
      </div>

      {partnerLoading ? (
        <p className="text-sm text-muted-foreground">Loading partner…</p>
      ) : partnerError ? (
        <p className="text-sm text-destructive" role="alert">
          {partnerError}
        </p>
      ) : !partner ? (
        <p className="text-sm text-muted-foreground">
          Please select a partner from the dropdown above.
        </p>
      ) : (
        <>
          <PartnerSummary partner={partner} />

          <section className="space-y-3 rounded-lg border p-4">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="keywords">Approved keywords</Label>
              <div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.json,.txt,text/csv,application/json"
                  className="hidden"
                  onChange={handleFileUpload}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={phase.status === "generating"}
                >
                  <UploadIcon className="mr-2 size-4" />
                  Upload CSV or JSON
                </Button>
              </div>
            </div>
            <Textarea
              id="keywords"
              placeholder="Paste the CSV export from the Keyword Research tab, or paste a JSON array / cluster object."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              className="min-h-[180px] font-mono text-xs"
              disabled={phase.status === "generating"}
            />
            <ParseStatus parsed={parsed} />

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={handleGenerate} disabled={!canGenerate}>
                {phase.status === "generating"
                  ? "Generating strategy…"
                  : "Generate Strategy"}
              </Button>
              {parsed.status === "ok" ? (
                <span className="text-xs text-muted-foreground">
                  {parsed.keywords.length} keywords · {parsed.clusters} cluster
                  {parsed.clusters === 1 ? "" : "s"} ({parsed.format.toUpperCase()})
                </span>
              ) : null}
            </div>
          </section>

          <Status phase={phase} />

          {phase.status === "done" ? (
            <StrategyView
              strategy={phase.strategy}
              usage={phase.usage}
              copyState={copyState}
              onCopy={handleCopy}
              onDownload={handleDownload}
            />
          ) : null}
        </>
      )}
    </div>
  )
}

function PartnerSummary({ partner }: { partner: Partner }) {
  const unfilled = partner.unfilledContext ?? []
  return (
    <section className="space-y-3 rounded-lg border p-4">
      <div>
        <h2 className="text-lg font-medium">{partner.name}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          <a
            href={partner.website}
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-foreground"
          >
            {partner.website}
          </a>
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Services
          </h3>
          <p className="mt-1 whitespace-pre-wrap text-sm">{partner.services}</p>
        </div>
        <div>
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Service areas
          </h3>
          <p className="mt-1 whitespace-pre-wrap text-sm">
            {partner.serviceAreas}
          </p>
        </div>
      </div>
      {unfilled.length > 0 ? (
        <p
          className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-900 dark:text-amber-200"
          role="status"
        >
          Heads up: {unfilled.join(", ")} still contain template boilerplate in
          Airtable. Strategy quality improves when these are filled in.
        </p>
      ) : null}
    </section>
  )
}

function ParseStatus({ parsed }: { parsed: ParseResult }) {
  if (parsed.status === "empty") {
    return (
      <p className="text-xs text-muted-foreground">
        Expected columns (CSV):{" "}
        <code className="font-mono">Keyword, Cluster, Volume, Difficulty, Fit Score, Intent, Recommendation</code>
        . JSON also accepted — array of scored keywords or{" "}
        <code className="font-mono">{"{ clusters: [{ name, keywords: [...] }] }"}</code>
        .
      </p>
    )
  }
  if (parsed.status === "error") {
    return (
      <p
        className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive"
        role="alert"
      >
        {parsed.message}
      </p>
    )
  }
  return null
}

function Status({ phase }: { phase: GenerationPhase }) {
  if (phase.status === "generating") {
    return (
      <p className="text-sm text-muted-foreground" aria-live="polite">
        Generating strategy… (usually 20-45 seconds)
      </p>
    )
  }
  if (phase.status === "error") {
    return (
      <p
        className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
        role="alert"
      >
        {phase.message}
      </p>
    )
  }
  return null
}

function StrategyView({
  strategy,
  usage,
  copyState,
  onCopy,
  onDownload,
}: {
  strategy: string
  usage: { inputTokens: number; outputTokens: number; estimatedCostUsd: number }
  copyState: "idle" | "copied"
  onCopy: () => void
  onDownload: () => void
}) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-medium">Strategy</h2>
          <Badge variant="secondary" className="text-[10px]" title="Input + output token totals from the Anthropic API response.">
            {usage.inputTokens.toLocaleString()} in ·{" "}
            {usage.outputTokens.toLocaleString()} out · ~
            {formatCurrency(usage.estimatedCostUsd)}
          </Badge>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onCopy}>
            {copyState === "copied" ? (
              <>
                <CheckIcon className="mr-2 size-4" />
                Copied
              </>
            ) : (
              <>
                <CopyIcon className="mr-2 size-4" />
                Copy
              </>
            )}
          </Button>
          <Button variant="outline" size="sm" onClick={onDownload}>
            <DownloadIcon className="mr-2 size-4" />
            Download .md
          </Button>
        </div>
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
          {strategy}
        </ReactMarkdown>
      </article>
    </section>
  )
}
