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
  url: string
  status_code: number | null
  title: string | null
  meta_description_length: number | null
  word_count: number | null
  internal_links: number | null
  external_links: number | null
  has_h1: boolean
}

const COLUMNS: ResultColumn<Row>[] = [
  { key: "url", label: "URL", accessor: (r) => r.url },
  { key: "status_code", label: "Status", numeric: true, accessor: (r) => r.status_code },
  {
    key: "title",
    label: "Title",
    accessor: (r) => r.title,
    format: (r) => r.title ?? "—",
  },
  {
    key: "meta_description_length",
    label: "Meta Desc Length",
    numeric: true,
    accessor: (r) => r.meta_description_length,
  },
  {
    key: "word_count",
    label: "Words",
    numeric: true,
    accessor: (r) => r.word_count,
  },
  {
    key: "internal_links",
    label: "Internal Links",
    numeric: true,
    accessor: (r) => r.internal_links,
  },
  {
    key: "external_links",
    label: "External Links",
    numeric: true,
    accessor: (r) => r.external_links,
  },
  {
    key: "has_h1",
    label: "H1",
    accessor: (r) => (r.has_h1 ? "yes" : "no"),
  },
]

export default function OnPagePage() {
  const tool = findToolByPathname("/technical/onpage")!
  const [target, setTarget] = useState("")
  const [maxPages, setMaxPages] = useState("50")
  const { rows, loading, error, run, setError } = useToolRun<Row>(
    "/api/tools/technical/onpage",
  )

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!target.trim()) {
      setError("Enter a target URL.")
      return
    }
    const pages = Number(maxPages)
    if (!Number.isFinite(pages) || pages < 1 || pages > 200) {
      setError("Max pages must be 1–200 for synchronous mode.")
      return
    }
    await run({ target: target.trim(), max_crawl_pages: pages })
  }

  return (
    <ToolShell
      category="Technical"
      title={tool.label}
      description={tool.description}
      endpoints={tool.endpoints}
      form={
        <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
          <div className="grow space-y-1.5 min-w-[260px]">
            <Label htmlFor="target">Site URL</Label>
            <Input
              id="target"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="https://example.com"
              disabled={loading}
            />
          </div>
          <div className="w-[140px] space-y-1.5">
            <Label htmlFor="max-pages">Max pages</Label>
            <Input
              id="max-pages"
              type="number"
              min={1}
              max={200}
              value={maxPages}
              onChange={(e) => setMaxPages(e.target.value)}
              disabled={loading}
            />
          </div>
          <Button type="submit" disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Crawl Site
          </Button>
        </form>
      }
      results={
        error ? (
          <ToolError message={error} />
        ) : (
          <ResultsTable rows={rows} columns={COLUMNS} filename="onpage" />
        )
      }
    />
  )
}
