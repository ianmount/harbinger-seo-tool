"use client"

import { useState, type FormEvent } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { MarketPicker } from "@/components/tool/MarketPicker"
import {
  ResultsTable,
  type ResultColumn,
} from "@/components/tool/ResultsTable"
import { ToolShell } from "@/components/tool/ToolShell"
import { ToolError, useToolRun } from "@/components/tool/use-tool-run"
import { findToolByPathname } from "@/lib/tool-config"
import type { DfsLabsLocation } from "@/lib/types"

type Row = {
  title: string
  category: string | null
  rating: number | null
  rating_count: number | null
  address: string | null
  phone: string | null
  url: string | null
}

const COLUMNS: ResultColumn<Row>[] = [
  { key: "title", label: "Business", accessor: (r) => r.title },
  {
    key: "category",
    label: "Category",
    accessor: (r) => r.category,
    format: (r) => r.category ?? "—",
  },
  {
    key: "rating",
    label: "Rating",
    numeric: true,
    accessor: (r) => r.rating,
    format: (r) => (r.rating == null ? "—" : r.rating.toFixed(1)),
  },
  {
    key: "rating_count",
    label: "Reviews",
    numeric: true,
    accessor: (r) => r.rating_count,
  },
  {
    key: "address",
    label: "Address",
    accessor: (r) => r.address,
    format: (r) => r.address ?? "—",
  },
  {
    key: "phone",
    label: "Phone",
    accessor: (r) => r.phone,
    format: (r) => r.phone ?? "—",
  },
]

export default function GbpPage() {
  const tool = findToolByPathname("/local/gbp")!
  const [keyword, setKeyword] = useState("")
  const [market, setMarket] = useState<DfsLabsLocation | null>(null)
  const { rows, loading, error, run, setError } = useToolRun<Row>(
    "/api/tools/local/gbp",
  )

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!keyword.trim()) {
      setError("Enter a business search keyword.")
      return
    }
    await run({
      keyword: keyword.trim(),
      location_code: market?.location_code,
      location_name: market ? undefined : "United States",
    })
  }

  return (
    <ToolShell
      category="Local"
      title={tool.label}
      description={tool.description}
      endpoints={tool.endpoints}
      form={
        <form
          onSubmit={onSubmit}
          className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_280px_auto] md:items-end"
        >
          <div className="space-y-1.5">
            <Label htmlFor="keyword">Business search</Label>
            <Input
              id="keyword"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="plumber atlanta"
              disabled={loading}
            />
          </div>
          <MarketPicker value={market} onChange={setMarket} />
          <Button type="submit" disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Pull GBP Listings
          </Button>
        </form>
      }
      results={
        error ? (
          <ToolError message={error} />
        ) : (
          <ResultsTable rows={rows} columns={COLUMNS} filename="gbp-coverage" />
        )
      }
    />
  )
}
