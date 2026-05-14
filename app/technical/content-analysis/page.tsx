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
  title: string | null
  date: string | null
  domain_rank: number | null
  sentiment_score: number | null
  language: string | null
}

const COLUMNS: ResultColumn<Row>[] = [
  { key: "url", label: "URL", accessor: (r) => r.url },
  {
    key: "title",
    label: "Title",
    accessor: (r) => r.title,
    format: (r) => r.title ?? "—",
  },
  {
    key: "date",
    label: "Date",
    accessor: (r) => r.date,
    format: (r) => (r.date ? r.date.slice(0, 10) : "—"),
  },
  {
    key: "domain_rank",
    label: "Domain Rank",
    numeric: true,
    accessor: (r) => r.domain_rank,
  },
  {
    key: "sentiment_score",
    label: "Sentiment",
    numeric: true,
    accessor: (r) => r.sentiment_score,
    format: (r) =>
      r.sentiment_score == null ? "—" : r.sentiment_score.toFixed(2),
  },
  {
    key: "language",
    label: "Lang",
    accessor: (r) => r.language,
    format: (r) => r.language ?? "—",
  },
]

export default function ContentAnalysisPage() {
  const tool = findToolByPathname("/technical/content-analysis")!
  const [keyword, setKeyword] = useState("")
  const { rows, loading, error, run, setError } = useToolRun<Row>(
    "/api/tools/technical/content-analysis",
  )

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!keyword.trim()) {
      setError("Enter a keyword or phrase.")
      return
    }
    await run({ keyword: keyword.trim() })
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
            <Label htmlFor="keyword">Keyword or phrase</Label>
            <Input
              id="keyword"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="example brand or topic"
              disabled={loading}
            />
          </div>
          <Button type="submit" disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Search Content
          </Button>
        </form>
      }
      results={
        error ? (
          <ToolError message={error} />
        ) : (
          <ResultsTable rows={rows} columns={COLUMNS} filename="content-analysis" />
        )
      }
    />
  )
}
