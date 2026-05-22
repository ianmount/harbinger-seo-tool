"use client"

import { useState, type FormEvent } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  LinkBuildingView,
  type LinkBuildingData,
} from "@/components/tool/backlinks/LinkBuildingView"
import { ToolShell } from "@/components/tool/ToolShell"
import { ToolError, useToolRun } from "@/components/tool/use-tool-run"
import { findToolByPathname } from "@/lib/tool-config"

type Data = LinkBuildingData

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
          <LinkBuildingView
            data={
              data ?? {
                competitors: [],
                domainIntersection: [],
                pageIntersection: [],
              }
            }
          />
        )
      }
    />
  )
}
