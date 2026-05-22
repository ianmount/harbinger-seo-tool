"use client"

import { useState, type FormEvent } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  LighthouseView,
  type LighthouseData,
} from "@/components/tool/technical/LighthouseView"
import { ToolShell } from "@/components/tool/ToolShell"
import { ToolError, useToolRun } from "@/components/tool/use-tool-run"
import { findToolByPathname } from "@/lib/tool-config"

type Data = LighthouseData

export default function LighthousePage() {
  const tool = findToolByPathname("/technical/lighthouse")!
  const [url, setUrl] = useState("")
  const [device, setDevice] = useState<"desktop" | "mobile">("mobile")
  const { data, meta, loading, error, run, setError } = useToolRun<Data>(
    "/api/tools/technical/lighthouse",
  )

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!url.trim()) {
      setError("Enter a URL.")
      return
    }
    await run({ url: url.trim(), for_mobile: device === "mobile" })
  }

  return (
    <ToolShell
      category="Technical"
      title={tool.label}
      description={tool.description}
      endpoints={tool.endpoints}
      meta={meta}
      save={{
        kind: "lighthouse_audit",
        enabled: data != null,
        getDefaultTitle: () => `${url || "URL"} — Lighthouse`,
        getData: () => ({
          url,
          capturedAt: new Date().toISOString(),
          ...data,
        }),
      }}
      form={
        <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
          <div className="grow space-y-1.5 min-w-[260px]">
            <Label htmlFor="url">URL</Label>
            <Input
              id="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/page"
              disabled={loading}
            />
          </div>
          <div className="w-[160px] space-y-1.5">
            <Label>Device</Label>
            <Select
              value={device}
              onValueChange={(v) => setDevice(v as "desktop" | "mobile")}
              disabled={loading}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mobile">Mobile</SelectItem>
                <SelectItem value="desktop">Desktop</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button type="submit" disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Run Lighthouse
          </Button>
        </form>
      }
      results={
        error ? (
          <ToolError message={error} />
        ) : (
          <LighthouseView data={data ?? { rows: [] }} />
        )
      }
    />
  )
}
