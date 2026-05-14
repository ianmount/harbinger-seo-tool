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

type RankedRow = {
  keyword: string
  labs_position: number | null
  live_position: number | null
  search_volume: number | null
  cpc: number | null
  url: string | null
  etv: number | null
}

type HistoryRow = {
  date: string
  organic_count: number | null
  organic_etv: number | null
  paid_count: number | null
  paid_etv: number | null
}

type RelevantPageRow = {
  url: string
  keywords_count: number | null
  etv: number | null
}

type Data = {
  ranked: RankedRow[]
  history: HistoryRow[]
  relevantPages: RelevantPageRow[]
}

const RANKED_COLS: ResultColumn<RankedRow>[] = [
  { key: "keyword", label: "Keyword", accessor: (r) => r.keyword },
  {
    key: "labs_position",
    label: "Labs Pos.",
    numeric: true,
    accessor: (r) => r.labs_position,
  },
  {
    key: "live_position",
    label: "Live Pos. (city)",
    numeric: true,
    accessor: (r) => r.live_position,
    format: (r) => (r.live_position == null ? "—" : r.live_position),
  },
  {
    key: "search_volume",
    label: "Volume",
    numeric: true,
    accessor: (r) => r.search_volume,
    format: (r) =>
      r.search_volume == null ? "—" : r.search_volume.toLocaleString(),
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
    format: (r) => (r.etv == null ? "—" : Math.round(r.etv).toLocaleString()),
  },
]

const HISTORY_COLS: ResultColumn<HistoryRow>[] = [
  { key: "date", label: "Date", accessor: (r) => r.date },
  {
    key: "organic_count",
    label: "Organic KW",
    numeric: true,
    accessor: (r) => r.organic_count,
  },
  {
    key: "organic_etv",
    label: "Organic Traffic",
    numeric: true,
    accessor: (r) => r.organic_etv,
    format: (r) =>
      r.organic_etv == null ? "—" : Math.round(r.organic_etv).toLocaleString(),
  },
  {
    key: "paid_count",
    label: "Paid KW",
    numeric: true,
    accessor: (r) => r.paid_count,
  },
  {
    key: "paid_etv",
    label: "Paid Traffic",
    numeric: true,
    accessor: (r) => r.paid_etv,
    format: (r) =>
      r.paid_etv == null ? "—" : Math.round(r.paid_etv).toLocaleString(),
  },
]

const PAGE_COLS: ResultColumn<RelevantPageRow>[] = [
  { key: "url", label: "Ranking Page", accessor: (r) => r.url },
  {
    key: "keywords_count",
    label: "Keywords",
    numeric: true,
    accessor: (r) => r.keywords_count,
  },
  {
    key: "etv",
    label: "Est. Traffic",
    numeric: true,
    accessor: (r) => r.etv,
    format: (r) => (r.etv == null ? "—" : Math.round(r.etv).toLocaleString()),
  },
]

export default function OrganicRankingsPage() {
  const tool = findToolByPathname("/competitive/organic-rankings")!
  const [target, setTarget] = useState("")
  const [market, setMarket] = useState<DfsLabsLocation | null>(null)
  const { data, meta, loading, error, run, setError } = useToolRun<Data>(
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
      meta={meta}
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
          <>
            <ToolSection
              title="Ranked Keywords"
              description="Labs position + live city-level SERP position for the top 25 keywords (cost-capped)."
            >
              <ResultsTable
                rows={data?.ranked ?? []}
                columns={RANKED_COLS}
                filename="ranked-keywords"
              />
            </ToolSection>
            <ToolSection title="Historical Rank Overview">
              <ResultsTable
                rows={data?.history ?? []}
                columns={HISTORY_COLS}
                filename="rank-history"
              />
            </ToolSection>
            <ToolSection title="Ranking Pages">
              <ResultsTable
                rows={data?.relevantPages ?? []}
                columns={PAGE_COLS}
                filename="ranking-pages"
              />
            </ToolSection>
          </>
        )
      }
    />
  )
}
