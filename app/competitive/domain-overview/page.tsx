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
import {
  ToolError,
  ToolSection,
  useToolRun,
} from "@/components/tool/use-tool-run"
import { findToolByPathname } from "@/lib/tool-config"
import type { DfsLabsLocation } from "@/lib/types"

type SnapshotRow = {
  group: string
  metric: string
  value: number | string | null
}

type CompetitorRow = {
  domain: string
  rank: number | null
  organic_keywords: number | null
  organic_traffic: number | null
  organic_cost: number | null
  overlap_with_target: number | null
}

type SerpRow = {
  position: number
  domain: string
  url: string
  title: string | null
}

type Data = {
  snapshot: SnapshotRow[]
  competitors: CompetitorRow[]
  brandSerp: SerpRow[]
}

const SNAPSHOT_COLS: ResultColumn<SnapshotRow>[] = [
  { key: "group", label: "Group", accessor: (r) => r.group },
  { key: "metric", label: "Metric", accessor: (r) => r.metric },
  {
    key: "value",
    label: "Value",
    numeric: true,
    accessor: (r) => r.value,
    format: (r) =>
      r.value == null
        ? "—"
        : typeof r.value === "number"
          ? r.value.toLocaleString()
          : r.value,
  },
]

const COMPETITOR_COLS: ResultColumn<CompetitorRow>[] = [
  { key: "domain", label: "Competitor", accessor: (r) => r.domain },
  { key: "rank", label: "Avg. Pos.", numeric: true, accessor: (r) => r.rank },
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

const SERP_COLS: ResultColumn<SerpRow>[] = [
  { key: "position", label: "Pos.", numeric: true, accessor: (r) => r.position },
  { key: "domain", label: "Domain", accessor: (r) => r.domain },
  {
    key: "title",
    label: "Title",
    accessor: (r) => r.title,
    format: (r) => r.title ?? "—",
  },
  { key: "url", label: "URL", accessor: (r) => r.url },
]

export default function DomainOverviewPage() {
  const tool = findToolByPathname("/competitive/domain-overview")!
  const [target, setTarget] = useState("")
  const [market, setMarket] = useState<DfsLabsLocation | null>(null)
  const { data, meta, loading, error, run, setError } = useToolRun<Data>(
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
      meta={meta}
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
          <>
            <ToolSection
              title="Snapshot"
              description="Organic, paid, and backlink metrics for the target at the selected market."
            >
              <ResultsTable
                rows={data?.snapshot ?? []}
                columns={SNAPSHOT_COLS}
                filename="domain-snapshot"
              />
            </ToolSection>
            <ToolSection title="Organic Competitors">
              <ResultsTable
                rows={data?.competitors ?? []}
                columns={COMPETITOR_COLS}
                filename="domain-competitors"
              />
            </ToolSection>
            <ToolSection
              title="Brand SERP (city-level)"
              description="Top 10 organic results when searching for the brand domain in the selected market."
            >
              <ResultsTable
                rows={data?.brandSerp ?? []}
                columns={SERP_COLS}
                filename="domain-brand-serp"
              />
            </ToolSection>
          </>
        )
      }
    />
  )
}
