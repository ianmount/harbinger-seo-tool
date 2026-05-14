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
  source: string
  labs_volume: number | null
  ads_volume: number | null
  cpc: number | null
  competition_level: string | null
  keyword_difficulty: number | null
}

type Data = { rows: Row[] }

const COLUMNS: ResultColumn<Row>[] = [
  { key: "keyword", label: "Keyword Idea", accessor: (r) => r.keyword },
  { key: "source", label: "Source", accessor: (r) => r.source },
  {
    key: "labs_volume",
    label: "Labs Vol.",
    numeric: true,
    accessor: (r) => r.labs_volume,
    format: (r) => (r.labs_volume == null ? "—" : r.labs_volume.toLocaleString()),
  },
  {
    key: "ads_volume",
    label: "Ads City Vol.",
    numeric: true,
    accessor: (r) => r.ads_volume,
    format: (r) => (r.ads_volume == null ? "—" : r.ads_volume.toLocaleString()),
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
  },
]

export default function KeywordMagicPage() {
  const tool = findToolByPathname("/keywords/magic")!
  const [seed, setSeed] = useState("")
  const [market, setMarket] = useState<DfsLabsLocation | null>(null)
  const { data, meta, loading, error, run, setError } = useToolRun<Data>(
    "/api/tools/keywords/magic",
  )

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!seed.trim()) {
      setError("Enter a seed keyword.")
      return
    }
    await run({
      seed: seed.trim(),
      location_code: market?.location_code,
      location_name: market ? undefined : "United States",
    })
  }

  return (
    <ToolShell
      category="Keywords"
      title={tool.label}
      description={tool.description}
      endpoints={tool.endpoints}
      meta={meta}
      form={
        <form onSubmit={onSubmit} className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_280px]">
          <div className="space-y-1.5">
            <Label htmlFor="seed">Seed keyword</Label>
            <Input
              id="seed"
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
              placeholder="plumber"
              disabled={loading}
            />
          </div>
          <div className="flex flex-col gap-3">
            <MarketPicker value={market} onChange={setMarket} />
            <Button type="submit" disabled={loading} className="mt-auto">
              {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Run Keyword Magic
            </Button>
          </div>
        </form>
      }
      results={
        error ? (
          <ToolError message={error} />
        ) : (
          <ResultsTable
            rows={data?.rows ?? []}
            columns={COLUMNS}
            filename="keyword-magic"
          />
        )
      }
    />
  )
}
