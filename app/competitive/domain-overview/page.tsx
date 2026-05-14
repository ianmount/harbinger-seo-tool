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
  domain: string
  rank: number | null
  organic_keywords: number | null
  organic_traffic: number | null
  organic_cost: number | null
  overlap_with_target: number | null
}

const COLUMNS: ResultColumn<Row>[] = [
  { key: "domain", label: "Competitor", accessor: (r) => r.domain },
  { key: "rank", label: "Rank", numeric: true, accessor: (r) => r.rank },
  {
    key: "organic_keywords",
    label: "Organic KW",
    numeric: true,
    accessor: (r) => r.organic_keywords,
    format: (r) =>
      r.organic_keywords == null ? "—" : r.organic_keywords.toLocaleString(),
  },
  {
    key: "organic_traffic",
    label: "Est. Traffic",
    numeric: true,
    accessor: (r) => r.organic_traffic,
    format: (r) =>
      r.organic_traffic == null ? "—" : r.organic_traffic.toLocaleString(),
  },
  {
    key: "organic_cost",
    label: "Traffic Cost",
    numeric: true,
    accessor: (r) => r.organic_cost,
    xlsxNumFmt: "$0",
    format: (r) =>
      r.organic_cost == null
        ? "—"
        : `$${Math.round(r.organic_cost).toLocaleString()}`,
  },
  {
    key: "overlap_with_target",
    label: "Overlap",
    numeric: true,
    accessor: (r) => r.overlap_with_target,
  },
]

export default function DomainOverviewPage() {
  const tool = findToolByPathname("/competitive/domain-overview")!
  const [target, setTarget] = useState("")
  const [market, setMarket] = useState<DfsLabsLocation | null>(null)
  const { rows, loading, error, run, setError } = useToolRun<Row>(
    "/api/tools/competitive/domain-overview",
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
            <Label htmlFor="target">Target domain</Label>
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
            Run Overview
          </Button>
        </form>
      }
      results={
        error ? (
          <ToolError message={error} />
        ) : (
          <ResultsTable rows={rows} columns={COLUMNS} filename="domain-overview" />
        )
      }
    />
  )
}
