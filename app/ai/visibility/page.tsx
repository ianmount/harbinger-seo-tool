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

type AggregatedRow = { metric: string; value: number | string | null }
type DomainRow = { domain: string; mentions: number | null }
type PageRow = { url: string; mentions: number | null }

type Data = {
  aggregated: AggregatedRow[]
  topDomains: DomainRow[]
  topPages: PageRow[]
}

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

const DOMAIN_COLS: ResultColumn<DomainRow>[] = [
  { key: "domain", label: "Domain", accessor: (r) => r.domain },
  {
    key: "mentions",
    label: "Mentions",
    numeric: true,
    accessor: (r) => r.mentions,
    format: (r) => (r.mentions == null ? "—" : r.mentions.toLocaleString()),
  },
]

const PAGE_COLS: ResultColumn<PageRow>[] = [
  { key: "url", label: "URL", accessor: (r) => r.url },
  {
    key: "mentions",
    label: "Mentions",
    numeric: true,
    accessor: (r) => r.mentions,
    format: (r) => (r.mentions == null ? "—" : r.mentions.toLocaleString()),
  },
]

export default function AiVisibilityPage() {
  const tool = findToolByPathname("/ai/visibility")!
  const [keyword, setKeyword] = useState("")
  const { data, meta, loading, error, run, setError } = useToolRun<Data>(
    "/api/tools/ai/visibility",
  )

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!keyword.trim()) {
      setError("Enter a keyword or topic.")
      return
    }
    await run({ keyword: keyword.trim() })
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
            <Label htmlFor="keyword">Keyword / topic</Label>
            <Input
              id="keyword"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="best plumber atlanta"
              disabled={loading}
            />
          </div>
          <Button type="submit" disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Run Visibility
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
                rows={data?.aggregated ?? []}
                columns={AGG_COLS}
                filename="ai-visibility-aggregated"
              />
            </ToolSection>
            <ToolSection title="Top Domains in LLM Responses">
              <ResultsTable
                rows={data?.topDomains ?? []}
                columns={DOMAIN_COLS}
                filename="ai-visibility-top-domains"
              />
            </ToolSection>
            <ToolSection title="Top Pages Cited by LLMs">
              <ResultsTable
                rows={data?.topPages ?? []}
                columns={PAGE_COLS}
                filename="ai-visibility-top-pages"
              />
            </ToolSection>
          </>
        )
      }
    />
  )
}
