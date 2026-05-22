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

type DomainRow = {
  domain: string
  rank: number | null
  backlinks: number | null
  first_seen: string | null
  lost_date: string | null
  dofollow: number | null
}

type NetworkRow = {
  network: string
  network_type: string | null
  referring_domains: number | null
  backlinks: number | null
}

type Data = { domains: DomainRow[]; networks: NetworkRow[] }

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

export default function ReferringDomainsPage() {
  const tool = findToolByPathname("/backlinks/referring-domains")!
  const [target, setTarget] = useState("")
  const { data, meta, loading, error, run, setError } = useToolRun<Data>(
    "/api/tools/backlinks/referring-domains",
  )

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!target.trim()) {
      setError("Enter a domain or URL.")
      return
    }
    await run({ target: target.trim() })
  }

  return (
    <ToolShell
      category="Backlinks"
      title={tool.label}
      description={tool.description}
      endpoints={tool.endpoints}
      meta={meta}
      save={{
        kind: "referring_domains",
        enabled: data != null,
        getDefaultTitle: () => `${target || "Domain"} — Referring domains`,
        getData: () => ({
          target,
          capturedAt: new Date().toISOString(),
          ...data,
        }),
      }}
      form={
        <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
          <div className="grow space-y-1.5 min-w-[260px]">
            <Label htmlFor="target">Target domain or URL</Label>
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
            Pull Referring Domains
          </Button>
        </form>
      }
      results={
        error ? (
          <ToolError message={error} />
        ) : (
          <>
            <ToolSection title="Referring Domains">
              <ResultsTable
                rows={data?.domains ?? []}
                columns={DOMAIN_COLS}
                filename="referring-domains"
              />
            </ToolSection>
            <ToolSection
              title="Referring Networks"
              description="IPs / subnets that host multiple referring domains — useful for PBN detection."
            >
              <ResultsTable
                rows={data?.networks ?? []}
                columns={NETWORK_COLS}
                filename="referring-networks"
              />
            </ToolSection>
          </>
        )
      }
    />
  )
}
