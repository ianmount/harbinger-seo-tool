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
  domain: string
  rank: number | null
  backlinks: number | null
  first_seen: string | null
}

const COLUMNS: ResultColumn<Row>[] = [
  { key: "domain", label: "Competitor Domain", accessor: (r) => r.domain },
  { key: "rank", label: "Rank", numeric: true, accessor: (r) => r.rank },
  {
    key: "backlinks",
    label: "Shared Backlinks",
    numeric: true,
    accessor: (r) => r.backlinks,
    format: (r) => (r.backlinks == null ? "—" : r.backlinks.toLocaleString()),
  },
  {
    key: "first_seen",
    label: "First Seen",
    accessor: (r) => r.first_seen,
    format: (r) => (r.first_seen ? r.first_seen.slice(0, 10) : "—"),
  },
]

export default function LinkBuildingPage() {
  const tool = findToolByPathname("/backlinks/link-building")!
  const [target, setTarget] = useState("")
  const { rows, loading, error, run, setError } = useToolRun<Row>(
    "/api/tools/backlinks/link-building",
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
            <Label htmlFor="target">Your domain (find competitors that share backlinks)</Label>
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
            Find Link Opportunities
          </Button>
        </form>
      }
      results={
        error ? (
          <ToolError message={error} />
        ) : (
          <ResultsTable rows={rows} columns={COLUMNS} filename="link-building" />
        )
      }
    />
  )
}
