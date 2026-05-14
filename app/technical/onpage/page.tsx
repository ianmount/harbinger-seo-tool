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

type PageRow = {
  url: string
  status_code: number | null
  title: string | null
  meta_description_length: number | null
  word_count: number | null
  internal_links: number | null
  has_h1: boolean
}

type ResourceRow = {
  url: string
  resource_type: string | null
  status_code: number | null
  size: number | null
  fetch_time_ms: number | null
}

type LinkRow = {
  source: string
  target: string
  link_type: string | null
  direction: string | null
  status_code: number | null
}

type DuplicateRow = {
  field: string
  value: string
  affected_pages: number
  sample_url: string | null
}

type Data = {
  pages: PageRow[]
  resources: ResourceRow[]
  links: LinkRow[]
  duplicates: DuplicateRow[]
}

const PAGE_COLS: ResultColumn<PageRow>[] = [
  { key: "url", label: "URL", accessor: (r) => r.url },
  {
    key: "status_code",
    label: "Status",
    numeric: true,
    accessor: (r) => r.status_code,
  },
  {
    key: "title",
    label: "Title",
    accessor: (r) => r.title,
    format: (r) => r.title ?? "—",
  },
  {
    key: "meta_description_length",
    label: "Meta Desc Len",
    numeric: true,
    accessor: (r) => r.meta_description_length,
  },
  {
    key: "word_count",
    label: "Words",
    numeric: true,
    accessor: (r) => r.word_count,
  },
  {
    key: "internal_links",
    label: "Internal Links",
    numeric: true,
    accessor: (r) => r.internal_links,
  },
  { key: "has_h1", label: "H1", accessor: (r) => (r.has_h1 ? "yes" : "no") },
]

const RESOURCE_COLS: ResultColumn<ResourceRow>[] = [
  { key: "url", label: "Resource URL", accessor: (r) => r.url },
  {
    key: "resource_type",
    label: "Type",
    accessor: (r) => r.resource_type,
    format: (r) => r.resource_type ?? "—",
  },
  {
    key: "status_code",
    label: "Status",
    numeric: true,
    accessor: (r) => r.status_code,
  },
  {
    key: "size",
    label: "Size (bytes)",
    numeric: true,
    accessor: (r) => r.size,
    format: (r) => (r.size == null ? "—" : r.size.toLocaleString()),
  },
  {
    key: "fetch_time_ms",
    label: "Fetch (ms)",
    numeric: true,
    accessor: (r) => r.fetch_time_ms,
  },
]

const LINK_COLS: ResultColumn<LinkRow>[] = [
  { key: "source", label: "Source", accessor: (r) => r.source },
  { key: "target", label: "Target", accessor: (r) => r.target },
  {
    key: "link_type",
    label: "Type",
    accessor: (r) => r.link_type,
    format: (r) => r.link_type ?? "—",
  },
  {
    key: "direction",
    label: "Direction",
    accessor: (r) => r.direction,
    format: (r) => r.direction ?? "—",
  },
  {
    key: "status_code",
    label: "Status",
    numeric: true,
    accessor: (r) => r.status_code,
  },
]

const DUP_COLS: ResultColumn<DuplicateRow>[] = [
  { key: "field", label: "Tag", accessor: (r) => r.field },
  { key: "value", label: "Duplicated Value", accessor: (r) => r.value },
  {
    key: "affected_pages",
    label: "Affected",
    numeric: true,
    accessor: (r) => r.affected_pages,
  },
  {
    key: "sample_url",
    label: "Sample URL",
    accessor: (r) => r.sample_url,
    format: (r) => r.sample_url ?? "—",
  },
]

export default function OnPagePage() {
  const tool = findToolByPathname("/technical/onpage")!
  const [target, setTarget] = useState("")
  const [maxPages, setMaxPages] = useState("50")
  const { data, meta, loading, error, run, setError } = useToolRun<Data>(
    "/api/tools/technical/onpage",
  )

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!target.trim()) {
      setError("Enter a target URL.")
      return
    }
    const pages = Number(maxPages)
    if (!Number.isFinite(pages) || pages < 1 || pages > 200) {
      setError("Max pages must be 1–200 for synchronous mode.")
      return
    }
    await run({ target: target.trim(), max_crawl_pages: pages })
  }

  return (
    <ToolShell
      category="Technical"
      title={tool.label}
      description={tool.description}
      endpoints={tool.endpoints}
      meta={meta}
      form={
        <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
          <div className="grow space-y-1.5 min-w-[260px]">
            <Label htmlFor="target">Site URL</Label>
            <Input
              id="target"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="https://example.com"
              disabled={loading}
            />
          </div>
          <div className="w-[140px] space-y-1.5">
            <Label htmlFor="max-pages">Max pages</Label>
            <Input
              id="max-pages"
              type="number"
              min={1}
              max={200}
              value={maxPages}
              onChange={(e) => setMaxPages(e.target.value)}
              disabled={loading}
            />
          </div>
          <Button type="submit" disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Crawl Site
          </Button>
        </form>
      }
      results={
        error ? (
          <ToolError message={error} />
        ) : (
          <>
            <ToolSection title="Pages">
              <ResultsTable
                rows={data?.pages ?? []}
                columns={PAGE_COLS}
                filename="onpage-pages"
              />
            </ToolSection>
            <ToolSection title="Resources">
              <ResultsTable
                rows={data?.resources ?? []}
                columns={RESOURCE_COLS}
                filename="onpage-resources"
              />
            </ToolSection>
            <ToolSection title="Internal Links">
              <ResultsTable
                rows={data?.links ?? []}
                columns={LINK_COLS}
                filename="onpage-links"
              />
            </ToolSection>
            <ToolSection
              title="Duplicate Title / Description Tags"
              description="Pages sharing the same title or meta description — usually a thin-content or templating bug."
            >
              <ResultsTable
                rows={data?.duplicates ?? []}
                columns={DUP_COLS}
                filename="onpage-duplicate-tags"
              />
            </ToolSection>
          </>
        )
      }
    />
  )
}
