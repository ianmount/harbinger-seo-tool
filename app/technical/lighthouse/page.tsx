"use client"

import { useState, type FormEvent } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  ResultsTable,
  type ResultColumn,
} from "@/components/tool/ResultsTable"
import { ToolShell } from "@/components/tool/ToolShell"
import { ToolError, useToolRun } from "@/components/tool/use-tool-run"
import { findToolByPathname } from "@/lib/tool-config"

type Row = {
  category: string
  score: number | null
  display_value: string | null
}
type Data = { rows: Row[] }

const COLUMNS: ResultColumn<Row>[] = [
  { key: "category", label: "Metric", accessor: (r) => r.category },
  {
    key: "score",
    label: "Score",
    numeric: true,
    accessor: (r) => r.score,
    format: (r) =>
      r.score == null ? "—" : `${Math.round(r.score * 100)} / 100`,
  },
  {
    key: "display_value",
    label: "Value",
    accessor: (r) => r.display_value,
    format: (r) => r.display_value ?? "—",
  },
]

export default function LighthousePage() {
  const tool = findToolByPathname("/technical/lighthouse")!
  const [url, setUrl] = useState("")
  const [device, setDevice] = useState<"desktop" | "mobile">("mobile")
  const { data, meta, loading, error, run, setError } = useToolRun<Data>(
    "/api/tools/technical/lighthouse",
  )

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!url.trim()) {
      setError("Enter a URL.")
      return
    }
    await run({ url: url.trim(), for_mobile: device === "mobile" })
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
            <Label htmlFor="url">URL</Label>
            <Input
              id="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/page"
              disabled={loading}
            />
          </div>
          <div className="w-[160px] space-y-1.5">
            <Label>Device</Label>
            <Select
              value={device}
              onValueChange={(v) => setDevice(v as "desktop" | "mobile")}
              disabled={loading}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mobile">Mobile</SelectItem>
                <SelectItem value="desktop">Desktop</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button type="submit" disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Run Lighthouse
          </Button>
        </form>
      }
      results={
        error ? (
          <ToolError message={error} />
        ) : (
          <ResultsTable rows={data?.rows ?? []} columns={COLUMNS} filename="lighthouse" />
        )
      }
    />
  )
}
