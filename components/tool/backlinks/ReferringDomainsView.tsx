"use client"

import {
  ResultsTable,
  type ResultColumn,
} from "@/components/tool/ResultsTable"
import { ToolSection } from "@/components/tool/use-tool-run"

export interface DomainRow {
  domain: string
  rank: number | null
  backlinks: number | null
  first_seen: string | null
  lost_date: string | null
  dofollow: number | null
}

export interface NetworkRow {
  network: string
  network_type: string | null
  referring_domains: number | null
  backlinks: number | null
}

export interface ReferringDomainsData {
  domains: DomainRow[]
  networks: NetworkRow[]
}

const DOMAIN_COLS: ResultColumn<DomainRow>[] = [
  { key: "domain", label: "Referring Domain", accessor: (r) => r.domain },
  { key: "rank", label: "Domain Rank", numeric: true, accessor: (r) => r.rank },
  {
    key: "backlinks",
    label: "Backlinks",
    numeric: true,
    accessor: (r) => r.backlinks,
    format: (r) => (r.backlinks == null ? "—" : r.backlinks.toLocaleString()),
  },
  {
    key: "dofollow",
    label: "Dofollow",
    numeric: true,
    accessor: (r) => r.dofollow,
  },
  {
    key: "first_seen",
    label: "First Seen",
    accessor: (r) => r.first_seen,
    format: (r) => (r.first_seen ? r.first_seen.slice(0, 10) : "—"),
  },
  {
    key: "lost_date",
    label: "Lost",
    accessor: (r) => r.lost_date,
    format: (r) => (r.lost_date ? r.lost_date.slice(0, 10) : "—"),
  },
]

const NETWORK_COLS: ResultColumn<NetworkRow>[] = [
  { key: "network", label: "Network (IP/Subnet)", accessor: (r) => r.network },
  {
    key: "network_type",
    label: "Type",
    accessor: (r) => r.network_type,
    format: (r) => r.network_type ?? "—",
  },
  {
    key: "referring_domains",
    label: "Ref. Domains",
    numeric: true,
    accessor: (r) => r.referring_domains,
  },
  {
    key: "backlinks",
    label: "Backlinks",
    numeric: true,
    accessor: (r) => r.backlinks,
    format: (r) => (r.backlinks == null ? "—" : r.backlinks.toLocaleString()),
  },
]

export function ReferringDomainsView({ data }: { data: ReferringDomainsData }) {
  return (
    <>
      <ToolSection title="Referring Domains">
        <ResultsTable
          rows={data.domains ?? []}
          columns={DOMAIN_COLS}
          filename="referring-domains"
        />
      </ToolSection>
      <ToolSection title="Networks">
        <ResultsTable
          rows={data.networks ?? []}
          columns={NETWORK_COLS}
          filename="referring-domains-networks"
        />
      </ToolSection>
    </>
  )
}
