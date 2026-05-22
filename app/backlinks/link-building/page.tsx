"use client"

import { useState, type FormEvent } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
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

type CompetitorRow = {
  domain: string
  rank: number | null
  backlinks: number | null
  shared_backlinks: number | null
  first_seen: string | null
}

type IntersectionRow = {
  domain: string
  rank: number | null
  intersection_targets: string
}

type PageIntersectionRow = {
  url_from: string
  anchor: string | null
  rank: number | null
  intersection_targets: string
}

type Data = {
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

export default function LinkBuildingPage() {
  const tool = findToolByPathname("/backlinks/link-building")!
  const [target, setTarget] = useState("")
  const [competitorsText, setCompetitorsText] = useState("")
  const [pagesText, setPagesText] = useState("")
  const { data, meta, loading, error, run, setError } = useToolRun<Data>(
    "/api/tools/backlinks/link-building",
  )

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!target.trim()) {
      setError("Enter a target domain.")
      return
    }
    const competitors = competitorsText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 5)
    const pages = pagesText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 5)
    await run({ target: target.trim(), competitors, pages })
  }

  return (
    <ToolShell
      category="Backlinks"
      title={tool.label}
      description={tool.description}
      endpoints={tool.endpoints}
      meta={meta}
      save={{
        kind: "outreach_drafts",
        enabled: data != null,
        getDefaultTitle: () => `${target || "Domain"} — Link building`,
        getData: () => ({
          target,
          capturedAt: new Date().toISOString(),
          ...data,
        }),
      }}
      form={
        <form onSubmit={onSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="target">Your domain</Label>
            <Input
              id="target"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="example.com"
              disabled={loading}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="competitors">
                Competitor domains (optional, max 5) — required for domain
                intersection
              </Label>
              <Textarea
                id="competitors"
                value={competitorsText}
                onChange={(e) => setCompetitorsText(e.target.value)}
                placeholder={"competitor1.com\ncompetitor2.com"}
                rows={4}
                disabled={loading}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pages">
                Page URLs (optional, 2-5) — required for page intersection
              </Label>
              <Textarea
                id="pages"
                value={pagesText}
                onChange={(e) => setPagesText(e.target.value)}
                placeholder={"https://example.com/landing\nhttps://competitor.com/landing"}
                rows={4}
                disabled={loading}
              />
            </div>
          </div>
          <Button type="submit" disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Find Link Opportunities
          </Button>
        </form>
      }
      results={
        error ? (
          <ToolError message={error} />
        ) : (
          <>
            <ToolSection
              title="Competitors (Shared Backlinks)"
              description="Domains with backlink profiles overlapping your target."
            >
              <ResultsTable
                rows={data?.competitors ?? []}
                columns={COMPETITOR_COLS}
                filename="competitors"
              />
            </ToolSection>
            <ToolSection
              title="Domain Intersection"
              description="Referring domains that link to every domain in your set — strong outreach prospects."
            >
              <ResultsTable
                rows={data?.domainIntersection ?? []}
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
                rows={data?.pageIntersection ?? []}
                columns={PAGE_INTERSECTION_COLS}
                filename="page-intersection"
                emptyMessage="Add ≥2 page URLs above to run this query."
              />
            </ToolSection>
          </>
        )
      }
    />
  )
}
