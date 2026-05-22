"use client"

import { useState, type FormEvent } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { OnpageAuditView } from "@/components/tool/onpage/OnpageAuditView"
import { ToolShell } from "@/components/tool/ToolShell"
import { ToolError, useToolRun } from "@/components/tool/use-tool-run"
import { findToolByPathname } from "@/lib/tool-config"
import type { AuditReport } from "@/lib/onpage-audit"

// ── Page ────────────────────────────────────────────────────────────────────

export default function OnPagePage() {
  const tool = findToolByPathname("/technical/onpage")!
  const [target, setTarget] = useState("")
  const [maxPages, setMaxPages] = useState("50")
  const { data, meta, loading, error, run, setError } =
    useToolRun<AuditReport>("/api/tools/technical/onpage")

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
      save={{
        kind: "onpage_audit",
        enabled: data != null,
        getDefaultTitle: () => `${target || "Domain"} — On-page audit`,
        getData: () => ({
          target,
          capturedAt: new Date().toISOString(),
          ...data,
        }),
      }}
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
            Run audit
          </Button>
        </form>
      }
      results={
        error ? (
          <ToolError message={error} />
        ) : data ? (
          <OnpageAuditView data={data} />
        ) : null
      }
    />
  )
}
