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
import { findToolByPathname } from "@/lib/tool-config"

type Row = {
  url_from: string
  url_to: string
  anchor: string | null
  page_from_rank: number | null
  domain_from_rank: number | null
  dofollow: boolean
  first_seen: string | null
  last_seen: string | null
}

const COLUMNS: ResultColumn<Row>[] = [
  { key: "url_from", label: "Source URL", accessor: (r) => r.url_from },
  { key: "url_to", label: "Target URL", accessor: (r) => r.url_to },
  {
    key: "anchor",
    label: "Anchor Text",
    accessor: (r) => r.anchor,
    format: (r) => r.anchor ?? "—",
  },
  {
    key: "page_from_rank",
    label: "Page Rank",
    numeric: true,
    accessor: (r) => r.page_from_rank,
  },
  {
    key: "domain_from_rank",
    label: "Domain Rank",
    numeric: true,
    accessor: (r) => r.domain_from_rank,
  },
  {
    key: "dofollow",
    label: "Follow",
    accessor: (r) => (r.dofollow ? "dofollow" : "nofollow"),
  },
  {
    key: "first_seen",
    label: "First Seen",
    accessor: (r) => r.first_seen,
    format: (r) => (r.first_seen ? r.first_seen.slice(0, 10) : "—"),
  },
]

export default function BacklinksOverviewPage() {
  const tool = findToolByPathname("/backlinks/overview")!
  const [target, setTarget] = useState("")
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!target.trim()) {
      setError("Enter a domain or URL.")
      return
    }
    setLoading(true)
    try {
      const res = await fetch("/api/tools/backlinks/overview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: target.trim() }),
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
      category="Backlinks"
      title={tool.label}
      description={tool.description}
      endpoints={tool.endpoints}
      form={
        <form onSubmit={run} className="flex flex-wrap items-end gap-3">
          <div className="grow space-y-1.5 min-w-[260px]">
            <Label htmlFor="target">Target domain or URL</Label>
            <Input
              id="target"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="example.com or https://example.com/page"
              disabled={loading}
            />
          </div>
          <Button type="submit" disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Pull Backlinks
          </Button>
        </form>
      }
      results={
        error ? (
          <div className="rounded-lg border border-destructive/50 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : (
          <ResultsTable rows={rows} columns={COLUMNS} filename="backlinks" />
        )
      }
    />
  )
}
