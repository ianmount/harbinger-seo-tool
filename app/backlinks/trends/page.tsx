"use client"

import { useState, type FormEvent } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  ResultsTable,
  type ResultColumn,
} from "@/components/tool/ResultsTable"
import { ToolShell } from "@/components/tool/ToolShell"
import { ToolError, useToolRun } from "@/components/tool/use-tool-run"
import { findToolByPathname } from "@/lib/tool-config"

type Row = {
  date: string
  backlinks: number | null
  referring_domains: number | null
  new_backlinks: number | null
  lost_backlinks: number | null
  new_referring_domains: number | null
  lost_referring_domains: number | null
}

type Data = { rows: Row[] }

const formatNum = (n: number | null) =>
  n == null ? "—" : n.toLocaleString()

const COLUMNS: ResultColumn<Row>[] = [
  { key: "date", label: "Date", accessor: (r) => r.date },
  {
    key: "backlinks",
    label: "Backlinks",
    numeric: true,
    accessor: (r) => r.backlinks,
    format: (r) => formatNum(r.backlinks),
  },
  {
    key: "referring_domains",
    label: "Ref. Domains",
    numeric: true,
    accessor: (r) => r.referring_domains,
    format: (r) => formatNum(r.referring_domains),
  },
  {
    key: "new_backlinks",
    label: "New Links",
    numeric: true,
    accessor: (r) => r.new_backlinks,
    format: (r) => formatNum(r.new_backlinks),
  },
  {
    key: "lost_backlinks",
    label: "Lost Links",
    numeric: true,
    accessor: (r) => r.lost_backlinks,
    format: (r) => formatNum(r.lost_backlinks),
  },
  {
    key: "new_referring_domains",
    label: "New Domains",
    numeric: true,
    accessor: (r) => r.new_referring_domains,
    format: (r) => formatNum(r.new_referring_domains),
  },
  {
    key: "lost_referring_domains",
    label: "Lost Domains",
    numeric: true,
    accessor: (r) => r.lost_referring_domains,
    format: (r) => formatNum(r.lost_referring_domains),
  },
]

export default function BacklinksTrendsPage() {
  const tool = findToolByPathname("/backlinks/trends")!
  const [target, setTarget] = useState("")
  const { data, meta, loading, error, run, setError } = useToolRun<Data>(
    "/api/tools/backlinks/trends",
  )

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!target.trim()) {
      setError("Enter a target domain.")
      return
    }
    await run({ target: target.trim() })
  }

  return (
    <ToolShell
      category="Backlinks"
      title={tool.label}
      description={tool.description}
      endpoints={tool.endpoints}
      meta={meta}
      form={
        <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
          <div className="grow space-y-1.5 min-w-[260px]">
            <Label htmlFor="target">Target domain</Label>
            <Input
              id="target"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="example.com"
              disabled={loading}
            />
          </div>
          <Button type="submit" disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Pull Trends
          </Button>
        </form>
      }
      results={
        error ? (
          <ToolError message={error} />
        ) : (
          <ResultsTable
            rows={data?.rows ?? []}
            columns={COLUMNS}
            filename="backlink-trends"
          />
        )
      }
    />
  )
}
