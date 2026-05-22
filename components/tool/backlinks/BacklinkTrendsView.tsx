"use client"

import {
  ResultsTable,
  type ResultColumn,
} from "@/components/tool/ResultsTable"

export interface BacklinkTrendRow {
  date: string
  backlinks: number | null
  referring_domains: number | null
  new_backlinks: number | null
  lost_backlinks: number | null
  new_referring_domains: number | null
  lost_referring_domains: number | null
}

export interface BacklinkTrendsData {
  rows: BacklinkTrendRow[]
}

const formatNum = (n: number | null) => (n == null ? "—" : n.toLocaleString())

const COLUMNS: ResultColumn<BacklinkTrendRow>[] = [
  { key: "date", label: "Date", accessor: (r) => r.date },
  {
    key: "backlinks",
    label: "Backlinks",
    numeric: true,
    accessor: (r) => r.backlinks,
    format: (r) => formatNum(r.backlinks),
  },
  {
    key: "referring_domains",
    label: "Ref. Domains",
    numeric: true,
    accessor: (r) => r.referring_domains,
    format: (r) => formatNum(r.referring_domains),
  },
  {
    key: "new_backlinks",
    label: "New Links",
    numeric: true,
    accessor: (r) => r.new_backlinks,
    format: (r) => formatNum(r.new_backlinks),
  },
  {
    key: "lost_backlinks",
    label: "Lost Links",
    numeric: true,
    accessor: (r) => r.lost_backlinks,
    format: (r) => formatNum(r.lost_backlinks),
  },
  {
    key: "new_referring_domains",
    label: "New Domains",
    numeric: true,
    accessor: (r) => r.new_referring_domains,
    format: (r) => formatNum(r.new_referring_domains),
  },
  {
    key: "lost_referring_domains",
    label: "Lost Domains",
    numeric: true,
    accessor: (r) => r.lost_referring_domains,
    format: (r) => formatNum(r.lost_referring_domains),
  },
]

export function BacklinkTrendsView({ data }: { data: BacklinkTrendsData }) {
  return (
    <ResultsTable
      rows={data.rows ?? []}
      columns={COLUMNS}
      filename="backlink-trends"
    />
  )
}
