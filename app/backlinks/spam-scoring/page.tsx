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

type Row = { target: string; spam_score: number | null }
type Data = { rows: Row[] }

const COLUMNS: ResultColumn<Row>[] = [
  { key: "target", label: "Target", accessor: (r) => r.target },
  {
    key: "spam_score",
    label: "Spam Score",
    numeric: true,
    accessor: (r) => r.spam_score,
    format: (r) => (r.spam_score == null ? "—" : `${r.spam_score}`),
  },
]

export default function SpamScoringPage() {
  const tool = findToolByPathname("/backlinks/spam-scoring")!
  const [text, setText] = useState("")
  const { data, meta, loading, error, run, setError } = useToolRun<Data>(
    "/api/tools/backlinks/spam-scoring",
  )

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const targets = text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 1000)
    if (targets.length === 0) {
      setError("Enter at least one domain or URL.")
      return
    }
    await run({ targets })
  }

  return (
    <ToolShell
      category="Backlinks"
      title={tool.label}
      description={tool.description}
      endpoints={tool.endpoints}
      meta={meta}
      form={
        <form onSubmit={onSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="targets">Domains or URLs (one per line, max 1000)</Label>
            <Textarea
              id="targets"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={"example.com\nshady-link.biz\nhttps://news.site/article"}
              rows={8}
              disabled={loading}
            />
          </div>
          <Button type="submit" disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Score Targets
          </Button>
        </form>
      }
      results={
        error ? (
          <ToolError message={error} />
        ) : (
          <ResultsTable rows={data?.rows ?? []} columns={COLUMNS} filename="spam-score" />
        )
      }
    />
  )
}
