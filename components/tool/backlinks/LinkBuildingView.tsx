"use client"

import {
  ResultsTable,
  type ResultColumn,
} from "@/components/tool/ResultsTable"
import { ToolSection } from "@/components/tool/use-tool-run"

export interface CompetitorRow {
  domain: string
  rank: number | null
  backlinks: number | null
  shared_backlinks: number | null
  first_seen: string | null
}

export interface IntersectionRow {
  domain: string
  rank: number | null
  intersection_targets: string
}

export interface PageIntersectionRow {
  url_from: string
  anchor: string | null
  rank: number | null
  intersection_targets: string
}

export interface LinkBuildingData {
  competitors: CompetitorRow[]
  domainIntersection: IntersectionRow[]
  pageIntersection: PageIntersectionRow[]
}

const COMPETITOR_COLS: ResultColumn<CompetitorRow>[] = [
  { key: "domain", label: "Competitor Domain", accessor: (r) => r.domain },
  { key: "rank", label: "Rank", numeric: true, accessor: (r) => r.rank },
  {
    key: "shared_backlinks",
    label: "Shared Backlinks",
    numeric: true,
    accessor: (r) => r.shared_backlinks,
    format: (r) =>
      r.shared_backlinks == null
        ? "—"
        : r.shared_backlinks.toLocaleString(),
  },
  {
    key: "backlinks",
    label: "Total Backlinks",
    numeric: true,
    accessor: (r) => r.backlinks,
    format: (r) => (r.backlinks == null ? "—" : r.backlinks.toLocaleString()),
  },
  {
    key: "first_seen",
    label: "First Seen",
    accessor: (r) => r.first_seen,
    format: (r) => (r.first_seen ? r.first_seen.slice(0, 10) : "—"),
  },
]

const INTERSECTION_COLS: ResultColumn<IntersectionRow>[] = [
  { key: "domain", label: "Referring Domain", accessor: (r) => r.domain },
  { key: "rank", label: "Rank", numeric: true, accessor: (r) => r.rank },
  {
    key: "intersection_targets",
    label: "Links To",
    accessor: (r) => r.intersection_targets,
  },
]

const PAGE_INTERSECTION_COLS: ResultColumn<PageIntersectionRow>[] = [
  { key: "url_from", label: "Referring URL", accessor: (r) => r.url_from },
  {
    key: "anchor",
    label: "Anchor",
    accessor: (r) => r.anchor,
    format: (r) => r.anchor ?? "—",
  },
  { key: "rank", label: "Rank", numeric: true, accessor: (r) => r.rank },
  {
    key: "intersection_targets",
    label: "Links To Pages",
    accessor: (r) => r.intersection_targets,
  },
]

export function LinkBuildingView({ data }: { data: LinkBuildingData }) {
  return (
    <>
      <ToolSection
        title="Competitors (Shared Backlinks)"
        description="Domains with backlink profiles overlapping your target."
      >
        <ResultsTable
          rows={data.competitors ?? []}
          columns={COMPETITOR_COLS}
          filename="competitors"
        />
      </ToolSection>
      <ToolSection
        title="Domain Intersection"
        description="Referring domains that link to every domain in your set — strong outreach prospects."
      >
        <ResultsTable
          rows={data.domainIntersection ?? []}
          columns={INTERSECTION_COLS}
          filename="domain-intersection"
          emptyMessage="Add ≥1 competitor domain above to run this query."
        />
      </ToolSection>
      <ToolSection
        title="Page Intersection"
        description="Referring URLs that link to every page in your set."
      >
        <ResultsTable
          rows={data.pageIntersection ?? []}
          columns={PAGE_INTERSECTION_COLS}
          filename="page-intersection"
          emptyMessage="Add ≥2 page URLs above to run this query."
        />
      </ToolSection>
    </>
  )
}
