"use client"

import {
  ResultsTable,
  type ResultColumn,
} from "@/components/tool/ResultsTable"
import { ToolSection } from "@/components/tool/use-tool-run"

/**
 * Shared renderer for the /backlinks/list tool's results. Used by both
 * the live tool page and the saved-artifact viewer. The payload shape
 * mirrors the `Data` type produced by `/api/tools/backlinks/list`.
 */

export interface BacklinkRow {
  url_from: string
  url_to: string
  anchor: string | null
  page_from_rank: number | null
  domain_from_rank: number | null
  dofollow: boolean
  first_seen: string | null
  last_seen: string | null
}

export interface AnchorRow {
  anchor: string
  backlinks: number | null
  referring_domains: number | null
  first_seen: string | null
}

export interface BacklinksListData {
  backlinks: BacklinkRow[]
  anchors: AnchorRow[]
}

const BACKLINK_COLS: ResultColumn<BacklinkRow>[] = [
  { key: "url_from", label: "Source URL", accessor: (r) => r.url_from },
  { key: "url_to", label: "Target URL", accessor: (r) => r.url_to },
  {
    key: "anchor",
    label: "Anchor Text",
    accessor: (r) => r.anchor,
    format: (r) => r.anchor ?? "—",
  },
  {
    key: "page_from_rank",
    label: "Page Rank",
    numeric: true,
    accessor: (r) => r.page_from_rank,
  },
  {
    key: "domain_from_rank",
    label: "Domain Rank",
    numeric: true,
    accessor: (r) => r.domain_from_rank,
  },
  {
    key: "dofollow",
    label: "Follow",
    accessor: (r) => (r.dofollow ? "dofollow" : "nofollow"),
  },
  {
    key: "first_seen",
    label: "First Seen",
    accessor: (r) => r.first_seen,
    format: (r) => (r.first_seen ? r.first_seen.slice(0, 10) : "—"),
  },
]

const ANCHOR_COLS: ResultColumn<AnchorRow>[] = [
  { key: "anchor", label: "Anchor Text", accessor: (r) => r.anchor },
  {
    key: "backlinks",
    label: "Backlinks",
    numeric: true,
    accessor: (r) => r.backlinks,
    format: (r) => (r.backlinks == null ? "—" : r.backlinks.toLocaleString()),
  },
  {
    key: "referring_domains",
    label: "Ref. Domains",
    numeric: true,
    accessor: (r) => r.referring_domains,
    format: (r) =>
      r.referring_domains == null ? "—" : r.referring_domains.toLocaleString(),
  },
  {
    key: "first_seen",
    label: "First Seen",
    accessor: (r) => r.first_seen,
    format: (r) => (r.first_seen ? r.first_seen.slice(0, 10) : "—"),
  },
]

export function BacklinksListView({ data }: { data: BacklinksListData }) {
  return (
    <>
      <ToolSection title="Backlinks">
        <ResultsTable
          rows={data.backlinks ?? []}
          columns={BACKLINK_COLS}
          filename="backlinks"
        />
      </ToolSection>
      <ToolSection title="Top Anchor Texts">
        <ResultsTable
          rows={data.anchors ?? []}
          columns={ANCHOR_COLS}
          filename="backlinks-anchors"
        />
      </ToolSection>
    </>
  )
}
