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

type CitationRow = {
  url: string
  title: string | null
  date: string | null
  domain_rank: number | null
  sentiment_score: number | null
  language: string | null
}

type StatRow = { group: string; metric: string; value: number | string | null }

type TrendRow = {
  date: string
  label: string
  value: number | null
  kind: "phrase" | "category"
}

type Data = {
  citations: CitationRow[]
  stats: StatRow[]
  trends: TrendRow[]
}

const CITATION_COLS: ResultColumn<CitationRow>[] = [
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

const STAT_COLS: ResultColumn<StatRow>[] = [
  { key: "group", label: "Group", accessor: (r) => r.group },
  { key: "metric", label: "Metric", accessor: (r) => r.metric },
  {
    key: "value",
    label: "Value",
    numeric: true,
    accessor: (r) => r.value,
    format: (r) =>
      r.value == null
        ? "—"
        : typeof r.value === "number"
          ? r.value.toLocaleString()
          : r.value,
  },
]

const TREND_COLS: ResultColumn<TrendRow>[] = [
  { key: "kind", label: "Kind", accessor: (r) => r.kind },
  { key: "date", label: "Date", accessor: (r) => r.date },
  { key: "label", label: "Phrase / Category", accessor: (r) => r.label },
  {
    key: "value",
    label: "Citations",
    numeric: true,
    accessor: (r) => r.value,
  },
]

export default function ContentAnalysisPage() {
  const tool = findToolByPathname("/technical/content-analysis")!
  const [keyword, setKeyword] = useState("")
  const { data, meta, loading, error, run, setError } = useToolRun<Data>(
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
      meta={meta}
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
          <>
            <ToolSection title="Citations">
              <ResultsTable
                rows={data?.citations ?? []}
                columns={CITATION_COLS}
                filename="content-citations"
              />
            </ToolSection>
            <ToolSection title="Summary Stats">
              <ResultsTable
                rows={data?.stats ?? []}
                columns={STAT_COLS}
                filename="content-stats"
              />
            </ToolSection>
            <ToolSection title="Phrase + Category Trends">
              <ResultsTable
                rows={data?.trends ?? []}
                columns={TREND_COLS}
                filename="content-trends"
              />
            </ToolSection>
          </>
        )
      }
    />
  )
}
