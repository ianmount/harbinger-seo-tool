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

type MetricRow = { metric: string; value: number | string | null }
type MentionRow = {
  llm: string | null
  prompt: string | null
  brand_position: number | null
  total_brands_mentioned: number | null
  date: string | null
}

type Data = { metrics: MetricRow[]; mentions: MentionRow[] }

const METRIC_COLS: ResultColumn<MetricRow>[] = [
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

const MENTION_COLS: ResultColumn<MentionRow>[] = [
  {
    key: "llm",
    label: "LLM",
    accessor: (r) => r.llm,
    format: (r) => r.llm ?? "—",
  },
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

export default function BrandPerformancePage() {
  const tool = findToolByPathname("/ai/brand-performance")!
  const [brand, setBrand] = useState("")
  const { data, meta, loading, error, run, setError } = useToolRun<Data>(
    "/api/tools/ai/brand-performance",
  )

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!brand.trim()) {
      setError("Enter a brand name.")
      return
    }
    await run({ keyword: brand.trim() })
  }

  return (
    <ToolShell
      category="AI"
      title={tool.label}
      description={tool.description}
      endpoints={tool.endpoints}
      meta={meta}
      form={
        <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
          <div className="grow space-y-1.5 min-w-[260px]">
            <Label htmlFor="brand">Brand</Label>
            <Input
              id="brand"
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              placeholder="Acme Plumbing"
              disabled={loading}
            />
          </div>
          <Button type="submit" disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Pull Performance
          </Button>
        </form>
      }
      results={
        error ? (
          <ToolError message={error} />
        ) : (
          <>
            <ToolSection title="Aggregated Metrics">
              <ResultsTable
                rows={data?.metrics ?? []}
                columns={METRIC_COLS}
                filename="ai-brand-metrics"
              />
            </ToolSection>
            <ToolSection title="Raw Mentions">
              <ResultsTable
                rows={data?.mentions ?? []}
                columns={MENTION_COLS}
                filename="ai-brand-mentions"
              />
            </ToolSection>
          </>
        )
      }
    />
  )
}
