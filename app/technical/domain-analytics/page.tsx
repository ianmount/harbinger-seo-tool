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

type TechRow = {
  category: string
  technology: string
  group: string | null
  first_detected: string | null
}

type WhoisRow = { field: string; value: string }

type Data = { technologies: TechRow[]; whois: WhoisRow[] }

const TECH_COLS: ResultColumn<TechRow>[] = [
  { key: "category", label: "Category", accessor: (r) => r.category },
  { key: "technology", label: "Technology", accessor: (r) => r.technology },
  {
    key: "group",
    label: "Group",
    accessor: (r) => r.group,
    format: (r) => r.group ?? "—",
  },
  {
    key: "first_detected",
    label: "First Detected",
    accessor: (r) => r.first_detected,
    format: (r) => (r.first_detected ? r.first_detected.slice(0, 10) : "—"),
  },
]

const WHOIS_COLS: ResultColumn<WhoisRow>[] = [
  { key: "field", label: "Field", accessor: (r) => r.field },
  { key: "value", label: "Value", accessor: (r) => r.value },
]

export default function DomainAnalyticsPage() {
  const tool = findToolByPathname("/technical/domain-analytics")!
  const [target, setTarget] = useState("")
  const { data, meta, loading, error, run, setError } = useToolRun<Data>(
    "/api/tools/technical/domain-analytics",
  )

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!target.trim()) {
      setError("Enter a domain.")
      return
    }
    await run({ target: target.trim() })
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
            <Label htmlFor="target">Domain</Label>
            <Input
              id="target"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="example.com"
              disabled={loading}
            />
          </div>
          <Button type="submit" disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Pull Domain Analytics
          </Button>
        </form>
      }
      results={
        error ? (
          <ToolError message={error} />
        ) : (
          <>
            <ToolSection title="Detected Technologies">
              <ResultsTable
                rows={data?.technologies ?? []}
                columns={TECH_COLS}
                filename="technologies"
              />
            </ToolSection>
            <ToolSection title="WHOIS Overview">
              <ResultsTable
                rows={data?.whois ?? []}
                columns={WHOIS_COLS}
                filename="whois"
              />
            </ToolSection>
          </>
        )
      }
    />
  )
}
