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
}

const COLUMNS: ResultColumn<Row>[] = [
  { key: "date", label: "Date", accessor: (r) => r.date },
  {
    key: "backlinks",
    label: "Backlinks",
    numeric: true,
    accessor: (r) => r.backlinks,
    format: (r) => (r.backlinks == null ? "—" : r.backlinks.toLocaleString()),
  },
  {
    key: "referring_domains",
    label: "Ref. Domains",
    numeric: true,
    accessor: (r) => r.referring_domains,
    format: (r) =>
      r.referring_domains == null ? "—" : r.referring_domains.toLocaleString(),
  },
  {
    key: "new_backlinks",
    label: "New",
    numeric: true,
    accessor: (r) => r.new_backlinks,
  },
  {
    key: "lost_backlinks",
    label: "Lost",
    numeric: true,
    accessor: (r) => r.lost_backlinks,
  },
]

export default function BacklinksTrendsPage() {
  const tool = findToolByPathname("/backlinks/trends")!
  const [target, setTarget] = useState("")
  const { rows, loading, error, run, setError } = useToolRun<Row>(
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
          <ResultsTable rows={rows} columns={COLUMNS} filename="backlink-trends" />
        )
      }
    />
  )
}
