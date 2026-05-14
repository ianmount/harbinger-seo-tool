"use client"

import { useState, type FormEvent } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { MarketPicker } from "@/components/tool/MarketPicker"
import {
  ResultsTable,
  type ResultColumn,
} from "@/components/tool/ResultsTable"
import { ToolShell } from "@/components/tool/ToolShell"
import { ToolError, useToolRun } from "@/components/tool/use-tool-run"
import { findToolByPathname } from "@/lib/tool-config"
import type { DfsLabsLocation } from "@/lib/types"

type Row = {
  keyword: string
  position: number | null
  search_volume: number | null
  cpc: number | null
  url: string | null
  etv: number | null
}

const COLUMNS: ResultColumn<Row>[] = [
  { key: "keyword", label: "Keyword", accessor: (r) => r.keyword },
  { key: "position", label: "Position", numeric: true, accessor: (r) => r.position },
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
    key: "url",
    label: "Ranking URL",
    accessor: (r) => r.url,
    format: (r) => r.url ?? "—",
  },
  {
    key: "etv",
    label: "Est. Traffic",
    numeric: true,
    accessor: (r) => r.etv,
    format: (r) =>
      r.etv == null ? "—" : Math.round(r.etv).toLocaleString(),
  },
]

export default function OrganicRankingsPage() {
  const tool = findToolByPathname("/competitive/organic-rankings")!
  const [target, setTarget] = useState("")
  const [market, setMarket] = useState<DfsLabsLocation | null>(null)
  const { rows, loading, error, run, setError } = useToolRun<Row>(
    "/api/tools/competitive/organic-rankings",
  )

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!target.trim()) {
      setError("Enter a domain.")
      return
    }
    await run({
      target: target.trim(),
      location_code: market?.location_code,
      location_name: market ? undefined : "United States",
    })
  }

  return (
    <ToolShell
      category="Competitive Analysis"
      title={tool.label}
      description={tool.description}
      endpoints={tool.endpoints}
      form={
        <form
          onSubmit={onSubmit}
          className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_280px_auto] md:items-end"
        >
          <div className="space-y-1.5">
            <Label htmlFor="target">Domain</Label>
            <Input
              id="target"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="example.com"
              disabled={loading}
            />
          </div>
          <MarketPicker value={market} onChange={setMarket} />
          <Button type="submit" disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Pull Rankings
          </Button>
        </form>
      }
      results={
        error ? (
          <ToolError message={error} />
        ) : (
          <ResultsTable rows={rows} columns={COLUMNS} filename="organic-rankings" />
        )
      }
    />
  )
}
