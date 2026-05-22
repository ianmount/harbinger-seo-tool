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

type BacklinkRow = {
  url_from: string
  url_to: string
  anchor: string | null
  page_from_rank: number | null
  domain_from_rank: number | null
  dofollow: boolean
  first_seen: string | null
  last_seen: string | null
}

type AnchorRow = {
  anchor: string
  backlinks: number | null
  referring_domains: number | null
  first_seen: string | null
}

type Data = { backlinks: BacklinkRow[]; anchors: AnchorRow[] }

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

export default function BacklinksListPage() {
  const tool = findToolByPathname("/backlinks/list")!
  const [target, setTarget] = useState("")
  const { data, meta, loading, error, run, setError } = useToolRun<Data>(
    "/api/tools/backlinks/list",
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
        kind: "backlink_prospects",
        enabled: data != null,
        getDefaultTitle: () => `${target || "Domain"} — Backlinks list`,
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
              placeholder="example.com or https://example.com/page"
              disabled={loading}
            />
          </div>
          <Button type="submit" disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Pull Backlinks
          </Button>
        </form>
      }
      results={
        error ? (
          <ToolError message={error} />
        ) : (
          <>
            <ToolSection title="Backlinks">
              <ResultsTable
                rows={data?.backlinks ?? []}
                columns={BACKLINK_COLS}
                filename="backlinks"
              />
            </ToolSection>
            <ToolSection title="Top Anchor Texts">
              <ResultsTable
                rows={data?.anchors ?? []}
                columns={ANCHOR_COLS}
                filename="backlinks-anchors"
              />
            </ToolSection>
          </>
        )
      }
    />
  )
}
