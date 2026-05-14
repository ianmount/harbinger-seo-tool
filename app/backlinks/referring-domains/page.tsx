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
  domain: string
  rank: number | null
  backlinks: number | null
  first_seen: string | null
  lost_date: string | null
  dofollow: number | null
}

const COLUMNS: ResultColumn<Row>[] = [
  { key: "domain", label: "Referring Domain", accessor: (r) => r.domain },
  { key: "rank", label: "Domain Rank", numeric: true, accessor: (r) => r.rank },
  {
    key: "backlinks",
    label: "Backlinks",
    numeric: true,
    accessor: (r) => r.backlinks,
    format: (r) => (r.backlinks == null ? "—" : r.backlinks.toLocaleString()),
  },
  {
    key: "dofollow",
    label: "Dofollow",
    numeric: true,
    accessor: (r) => r.dofollow,
  },
  {
    key: "first_seen",
    label: "First Seen",
    accessor: (r) => r.first_seen,
    format: (r) => (r.first_seen ? r.first_seen.slice(0, 10) : "—"),
  },
  {
    key: "lost_date",
    label: "Lost",
    accessor: (r) => r.lost_date,
    format: (r) => (r.lost_date ? r.lost_date.slice(0, 10) : "—"),
  },
]

export default function ReferringDomainsPage() {
  const tool = findToolByPathname("/backlinks/referring-domains")!
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
      const res = await fetch("/api/tools/backlinks/referring-domains", {
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
              placeholder="example.com"
              disabled={loading}
            />
          </div>
          <Button type="submit" disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Pull Referring Domains
          </Button>
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
            filename="referring-domains"
          />
        )
      }
    />
  )
}
