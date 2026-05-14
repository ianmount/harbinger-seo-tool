"use client"

import { useState, type FormEvent } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  ResultsTable,
  type ResultColumn,
} from "@/components/tool/ResultsTable"
import { ToolShell } from "@/components/tool/ToolShell"
import { ToolError, useToolRun } from "@/components/tool/use-tool-run"
import { findToolByPathname } from "@/lib/tool-config"

type Row = {
  keyword: string
  mentions: number | null
  share_of_voice: number | null
  avg_position: number | null
}

const COLUMNS: ResultColumn<Row>[] = [
  { key: "keyword", label: "Brand / Keyword", accessor: (r) => r.keyword },
  {
    key: "mentions",
    label: "Mentions",
    numeric: true,
    accessor: (r) => r.mentions,
    format: (r) => (r.mentions == null ? "—" : r.mentions.toLocaleString()),
  },
  {
    key: "share_of_voice",
    label: "Share of Voice",
    numeric: true,
    accessor: (r) => r.share_of_voice,
    xlsxNumFmt: "0.0%",
    format: (r) =>
      r.share_of_voice == null ? "—" : `${(r.share_of_voice * 100).toFixed(1)}%`,
  },
  {
    key: "avg_position",
    label: "Avg. Position",
    numeric: true,
    accessor: (r) => r.avg_position,
    format: (r) => (r.avg_position == null ? "—" : r.avg_position.toFixed(1)),
  },
]

export default function CompetitorResearchPage() {
  const tool = findToolByPathname("/ai/competitor-research")!
  const [text, setText] = useState("")
  const { rows, loading, error, run, setError } = useToolRun<Row>(
    "/api/tools/ai/competitor-research",
  )

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const keywords = text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 50)
    if (keywords.length < 2) {
      setError("Enter at least two brands or keywords to compare.")
      return
    }
    await run({ keywords })
  }

  return (
    <ToolShell
      category="AI"
      title={tool.label}
      description={tool.description}
      endpoints={tool.endpoints}
      form={
        <form onSubmit={onSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="keywords">Brands or keywords (one per line)</Label>
            <Textarea
              id="keywords"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={"acme plumbing\nbest plumbers atlanta\nfive star plumbing"}
              rows={6}
              disabled={loading}
            />
          </div>
          <Button type="submit" disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Compare Mentions
          </Button>
        </form>
      }
      results={
        error ? (
          <ToolError message={error} />
        ) : (
          <ResultsTable rows={rows} columns={COLUMNS} filename="ai-competitor-research" />
        )
      }
    />
  )
}
