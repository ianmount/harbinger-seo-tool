"use client"

import { useState, type FormEvent } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  ReferringDomainsView,
  type ReferringDomainsData,
} from "@/components/tool/backlinks/ReferringDomainsView"
import { ToolShell } from "@/components/tool/ToolShell"
import { ToolError, useToolRun } from "@/components/tool/use-tool-run"
import { findToolByPathname } from "@/lib/tool-config"

type Data = ReferringDomainsData

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
          <ReferringDomainsView
            data={data ?? { domains: [], networks: [] }}
          />
        )
      }
    />
  )
}
