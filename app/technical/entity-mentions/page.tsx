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
  llm: string | null
  prompt: string | null
  brand_position: number | null
  total_brands_mentioned: number | null
  date: string | null
}

const COLUMNS: ResultColumn<Row>[] = [
  { key: "llm", label: "LLM", accessor: (r) => r.llm, format: (r) => r.llm ?? "—" },
  {
    key: "prompt",
    label: "Prompt",
    accessor: (r) => r.prompt,
    format: (r) => r.prompt ?? "—",
  },
  {
    key: "brand_position",
    label: "Brand Position",
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

export default function EntityMentionsPage() {
  const tool = findToolByPathname("/technical/entity-mentions")!
  const [entity, setEntity] = useState("")
  const { rows, loading, error, run, setError } = useToolRun<Row>(
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
          <ResultsTable rows={rows} columns={COLUMNS} filename="entity-mentions" />
        )
      }
    />
  )
}
