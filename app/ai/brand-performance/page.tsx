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
  metric: string
  value: number | null
}

const COLUMNS: ResultColumn<Row>[] = [
  { key: "metric", label: "Metric", accessor: (r) => r.metric },
  {
    key: "value",
    label: "Value",
    numeric: true,
    accessor: (r) => r.value,
    format: (r) => (r.value == null ? "—" : r.value.toLocaleString()),
  },
]

export default function BrandPerformancePage() {
  const tool = findToolByPathname("/ai/brand-performance")!
  const [brand, setBrand] = useState("")
  const { rows, loading, error, run, setError } = useToolRun<Row>(
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
          <ResultsTable rows={rows} columns={COLUMNS} filename="ai-brand-performance" />
        )
      }
    />
  )
}
