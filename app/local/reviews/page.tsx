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
import {
  ToolError,
  ToolSection,
  useToolRun,
} from "@/components/tool/use-tool-run"
import { findToolByPathname } from "@/lib/tool-config"

type StatRow = { category: string; bucket: string; value: number | null }
type TrendRow = { date: string; phrase: string; value: number | null }
type Data = { stats: StatRow[]; trends: TrendRow[] }

const STAT_COLS: ResultColumn<StatRow>[] = [
  { key: "category", label: "Group", accessor: (r) => r.category },
  { key: "bucket", label: "Bucket", accessor: (r) => r.bucket },
  {
    key: "value",
    label: "Count / Score",
    numeric: true,
    accessor: (r) => r.value,
    format: (r) => (r.value == null ? "—" : r.value.toLocaleString()),
  },
]

const TREND_COLS: ResultColumn<TrendRow>[] = [
  { key: "date", label: "Date", accessor: (r) => r.date },
  { key: "phrase", label: "Phrase", accessor: (r) => r.phrase },
  {
    key: "value",
    label: "Citations",
    numeric: true,
    accessor: (r) => r.value,
  },
]

export default function ReviewsPage() {
  const tool = findToolByPathname("/local/reviews")!
  const [keyword, setKeyword] = useState("")
  const { data, meta, loading, error, run, setError } = useToolRun<Data>(
    "/api/tools/local/reviews",
  )

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!keyword.trim()) {
      setError("Enter a brand or keyword.")
      return
    }
    await run({ keyword: keyword.trim() })
  }

  return (
    <ToolShell
      category="Local"
      title={tool.label}
      description={tool.description}
      endpoints={tool.endpoints}
      meta={meta}
      form={
        <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
          <div className="grow space-y-1.5 min-w-[260px]">
            <Label htmlFor="keyword">Brand or keyword</Label>
            <Input
              id="keyword"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="acme plumbing"
              disabled={loading}
            />
          </div>
          <Button type="submit" disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Analyze Reviews
          </Button>
        </form>
      }
      results={
        error ? (
          <ToolError message={error} />
        ) : (
          <>
            <ToolSection title="Sentiment + Rating Distribution">
              <ResultsTable
                rows={data?.stats ?? []}
                columns={STAT_COLS}
                filename="review-stats"
              />
            </ToolSection>
            <ToolSection title="Phrase Trends">
              <ResultsTable
                rows={data?.trends ?? []}
                columns={TREND_COLS}
                filename="review-phrase-trends"
              />
            </ToolSection>
          </>
        )
      }
    />
  )
}
