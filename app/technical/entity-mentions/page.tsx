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

type WebRow = {
  url: string
  title: string | null
  date: string | null
  domain_rank: number | null
}

type LlmRow = {
  llm: string | null
  prompt: string | null
  brand_position: number | null
  total_brands_mentioned: number | null
  date: string | null
}

type AggregatedRow = { metric: string; value: number | string | null }

type Data = { web: WebRow[]; llm: LlmRow[]; aggregated: AggregatedRow[] }

const WEB_COLS: ResultColumn<WebRow>[] = [
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
]

const LLM_COLS: ResultColumn<LlmRow>[] = [
  { key: "llm", label: "LLM", accessor: (r) => r.llm, format: (r) => r.llm ?? "—" },
  {
    key: "prompt",
    label: "Prompt",
    accessor: (r) => r.prompt,
    format: (r) => r.prompt ?? "—",
  },
  {
    key: "brand_position",
    label: "Brand Pos.",
    numeric: true,
    accessor: (r) => r.brand_position,
  },
  {
    key: "total_brands_mentioned",
    label: "Total Brands",
    numeric: true,
    accessor: (r) => r.total_brands_mentioned,
  },
  {
    key: "date",
    label: "Date",
    accessor: (r) => r.date,
    format: (r) => (r.date ? r.date.slice(0, 10) : "—"),
  },
]

const AGG_COLS: ResultColumn<AggregatedRow>[] = [
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

export default function EntityMentionsPage() {
  const tool = findToolByPathname("/technical/entity-mentions")!
  const [entity, setEntity] = useState("")
  const { data, meta, loading, error, run, setError } = useToolRun<Data>(
    "/api/tools/technical/entity-mentions",
  )

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!entity.trim()) {
      setError("Enter a brand or entity name.")
      return
    }
    await run({ keyword: entity.trim() })
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
            <Label htmlFor="entity">Brand or entity name</Label>
            <Input
              id="entity"
              value={entity}
              onChange={(e) => setEntity(e.target.value)}
              placeholder="Harbinger Marketing"
              disabled={loading}
            />
          </div>
          <Button type="submit" disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Search Mentions
          </Button>
        </form>
      }
      results={
        error ? (
          <ToolError message={error} />
        ) : (
          <>
            <ToolSection title="Aggregated LLM Metrics">
              <ResultsTable
                rows={data?.aggregated ?? []}
                columns={AGG_COLS}
                filename="entity-aggregated"
              />
            </ToolSection>
            <ToolSection title="LLM Mentions">
              <ResultsTable
                rows={data?.llm ?? []}
                columns={LLM_COLS}
                filename="entity-llm"
              />
            </ToolSection>
            <ToolSection title="Open-Web Mentions">
              <ResultsTable
                rows={data?.web ?? []}
                columns={WEB_COLS}
                filename="entity-web"
              />
            </ToolSection>
          </>
        )
      }
    />
  )
}
