"use client"

import { useState, type FormEvent } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { MarketPicker } from "@/components/tool/MarketPicker"
import {
  ResultsTable,
  type ResultColumn,
} from "@/components/tool/ResultsTable"
import { ToolShell } from "@/components/tool/ToolShell"
import { findToolByPathname } from "@/lib/tool-config"
import type { DfsLabsLocation } from "@/lib/types"

type Row = {
  keyword: string
  search_volume: number | null
  cpc: number | null
  competition_level: string | null
  competition: number | null
  keyword_difficulty: number | null
  main_intent: string | null
}

const COLUMNS: ResultColumn<Row>[] = [
  { key: "keyword", label: "Keyword", accessor: (r) => r.keyword },
  {
    key: "search_volume",
    label: "Volume",
    numeric: true,
    accessor: (r) => r.search_volume,
    format: (r) => (r.search_volume == null ? "—" : r.search_volume.toLocaleString()),
  },
  {
    key: "cpc",
    label: "CPC",
    numeric: true,
    accessor: (r) => r.cpc,
    xlsxNumFmt: "$0.00",
    format: (r) => (r.cpc == null ? "—" : `$${r.cpc.toFixed(2)}`),
  },
  {
    key: "competition_level",
    label: "Competition",
    accessor: (r) => r.competition_level,
    format: (r) => r.competition_level ?? "—",
  },
  {
    key: "keyword_difficulty",
    label: "Difficulty",
    numeric: true,
    accessor: (r) => r.keyword_difficulty,
    format: (r) => (r.keyword_difficulty == null ? "—" : r.keyword_difficulty),
  },
  {
    key: "main_intent",
    label: "Intent",
    accessor: (r) => r.main_intent,
    format: (r) => r.main_intent ?? "—",
  },
]

export default function KeywordOverviewPage() {
  const tool = findToolByPathname("/keywords/overview")!
  const [keywordsText, setKeywordsText] = useState("")
  const [market, setMarket] = useState<DfsLabsLocation | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const keywords = keywordsText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 100)
    if (keywords.length === 0) {
      setError("Enter at least one keyword.")
      return
    }
    setLoading(true)
    try {
      const res = await fetch("/api/tools/keywords/overview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          keywords,
          location_code: market?.location_code,
          location_name: market ? undefined : "United States",
        }),
      })
      const body = (await res.json()) as { rows?: Row[]; error?: string }
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      setRows(body.rows ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed")
    } finally {
      setLoading(false)
    }
  }

  return (
    <ToolShell
      category="Keywords"
      title={tool.label}
      description={tool.description}
      endpoints={tool.endpoints}
      form={
        <form onSubmit={run} className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_280px]">
          <div className="space-y-1.5">
            <Label htmlFor="keywords">Keywords (one per line, max 100)</Label>
            <Textarea
              id="keywords"
              value={keywordsText}
              onChange={(e) => setKeywordsText(e.target.value)}
              placeholder={"plumber\nemergency plumber\nplumbing contractor"}
              rows={6}
              disabled={loading}
            />
          </div>
          <div className="flex flex-col gap-3">
            <MarketPicker value={market} onChange={setMarket} />
            <Button type="submit" disabled={loading} className="mt-auto">
              {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Run Keyword Overview
            </Button>
          </div>
        </form>
      }
      results={
        error ? (
          <div className="rounded-lg border border-destructive/50 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : (
          <ResultsTable
            rows={rows}
            columns={COLUMNS}
            filename="keyword-overview"
          />
        )
      }
    />
  )
}
