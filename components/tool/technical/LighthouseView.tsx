"use client"

import {
  ResultsTable,
  type ResultColumn,
} from "@/components/tool/ResultsTable"

export interface LighthouseRow {
  category: string
  score: number | null
  display_value: string | null
}

export interface LighthouseData {
  rows: LighthouseRow[]
}

const COLUMNS: ResultColumn<LighthouseRow>[] = [
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

export function LighthouseView({ data }: { data: LighthouseData }) {
  return (
    <ResultsTable
      rows={data.rows ?? []}
      columns={COLUMNS}
      filename="lighthouse"
    />
  )
}
