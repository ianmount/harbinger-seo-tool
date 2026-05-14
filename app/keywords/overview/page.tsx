"use client"

import { useState, type FormEvent } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { MarketPicker } from "@/components/tool/MarketPicker"
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
import type { DfsLabsLocation } from "@/lib/types"

type KeywordRow = {
  keyword: string
  labs_volume: number | null
  ads_volume: number | null
  cpc: number | null
  competition_level: string | null
  keyword_difficulty: number | null
  main_intent: string | null
  serp_top_domain: string | null
}

type SerpRow = {
  keyword: string
  position: number
  domain: string
  url: string
  title: string | null
}

type MonthlyRow = {
  keyword: string
  date: string
  search_volume: number | null
}

type Data = {
  keywords: KeywordRow[]
  serp: SerpRow[]
  monthly: MonthlyRow[]
}

const KEYWORD_COLS: ResultColumn<KeywordRow>[] = [
  { key: "keyword", label: "Keyword", accessor: (r) => r.keyword },
  {
    key: "labs_volume",
    label: "Labs Vol.",
    numeric: true,
    accessor: (r) => r.labs_volume,
    format: (r) => (r.labs_volume == null ? "—" : r.labs_volume.toLocaleString()),
  },
  {
    key: "ads_volume",
    label: "Ads City Vol.",
    numeric: true,
    accessor: (r) => r.ads_volume,
    format: (r) => (r.ads_volume == null ? "—" : r.ads_volume.toLocaleString()),
  },
  {
    key: "cpc",
    label: "CPC",
    numeric: true,
    accessor: (r) => r.cpc,
    xlsxNumFmt: "$0.00",
    format: (r) => (r.cpc == null ? "—" : `$${r.cpc.toFixed(2)}`),
  },
  {
    key: "competition_level",
    label: "Competition",
    accessor: (r) => r.competition_level,
    format: (r) => r.competition_level ?? "—",
  },
  {
    key: "keyword_difficulty",
    label: "Difficulty",
    numeric: true,
    accessor: (r) => r.keyword_difficulty,
  },
  {
    key: "main_intent",
    label: "Intent",
    accessor: (r) => r.main_intent,
    format: (r) => r.main_intent ?? "—",
  },
  {
    key: "serp_top_domain",
    label: "Top SERP Domain",
    accessor: (r) => r.serp_top_domain,
    format: (r) => r.serp_top_domain ?? "—",
  },
]

const SERP_COLS: ResultColumn<SerpRow>[] = [
  { key: "keyword", label: "Keyword", accessor: (r) => r.keyword },
  { key: "position", label: "Pos.", numeric: true, accessor: (r) => r.position },
  { key: "domain", label: "Domain", accessor: (r) => r.domain },
  {
    key: "title",
    label: "Title",
    accessor: (r) => r.title,
    format: (r) => r.title ?? "—",
  },
  { key: "url", label: "URL", accessor: (r) => r.url },
]

const MONTHLY_COLS: ResultColumn<MonthlyRow>[] = [
  { key: "keyword", label: "Keyword", accessor: (r) => r.keyword },
  { key: "date", label: "Month", accessor: (r) => r.date },
  {
    key: "search_volume",
    label: "Volume",
    numeric: true,
    accessor: (r) => r.search_volume,
    format: (r) =>
      r.search_volume == null ? "—" : r.search_volume.toLocaleString(),
  },
]

export default function KeywordOverviewPage() {
  const tool = findToolByPathname("/keywords/overview")!
  const [keywordsText, setKeywordsText] = useState("")
  const [market, setMarket] = useState<DfsLabsLocation | null>(null)
  const { data, meta, loading, error, run, setError } = useToolRun<Data>(
    "/api/tools/keywords/overview",
  )

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const keywords = keywordsText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 100)
    if (keywords.length === 0) {
      setError("Enter at least one keyword.")
      return
    }
    await run({
      keywords,
      location_code: market?.location_code,
      location_name: market ? undefined : "United States",
    })
  }

  return (
    <ToolShell
      category="Keywords"
      title={tool.label}
      description={tool.description}
      endpoints={tool.endpoints}
      meta={meta}
      form={
        <form
          onSubmit={onSubmit}
          className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_280px]"
        >
          <div className="space-y-1.5">
            <Label htmlFor="keywords">Keywords (one per line, max 100)</Label>
            <Textarea
              id="keywords"
              value={keywordsText}
              onChange={(e) => setKeywordsText(e.target.value)}
              placeholder={"plumber\nemergency plumber\nplumbing contractor"}
              rows={6}
              disabled={loading}
            />
          </div>
          <div className="flex flex-col gap-3">
            <MarketPicker value={market} onChange={setMarket} />
            <Button type="submit" disabled={loading} className="mt-auto">
              {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Run Keyword Overview
            </Button>
          </div>
        </form>
      }
      results={
        error ? (
          <ToolError message={error} />
        ) : (
          <>
            <ToolSection title="Keywords">
              <ResultsTable
                rows={data?.keywords ?? []}
                columns={KEYWORD_COLS}
                filename="keyword-overview"
              />
            </ToolSection>
            <ToolSection
              title="SERP Composition (first 25 keywords)"
              description="Top 10 organic results per keyword at the selected market."
            >
              <ResultsTable
                rows={data?.serp ?? []}
                columns={SERP_COLS}
                filename="keyword-serp"
              />
            </ToolSection>
            <ToolSection
              title="Monthly Volume History"
              description="Up to 4 years of historical Labs search-volume data."
            >
              <ResultsTable
                rows={data?.monthly ?? []}
                columns={MONTHLY_COLS}
                filename="keyword-monthly"
              />
            </ToolSection>
          </>
        )
      }
    />
  )
}
