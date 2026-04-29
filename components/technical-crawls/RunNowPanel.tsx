"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import type { Partner } from "@/lib/types"
import type { CrawlRunFull } from "./types"

/**
 * Kicks off a new technical crawl — either against a known Airtable
 * partner or against an arbitrary URL. Calls /api/technical-crawls/run
 * synchronously; the endpoint can take a few minutes on large sites, so
 * we surface a "this can take 5 minutes" hint and disable the button
 * while in flight.
 */
export function RunNowPanel({
  onCompleted,
}: {
  onCompleted?: (run: CrawlRunFull) => void
}) {
  const [mode, setMode] = useState<"partner" | "url">("partner")
  const [partners, setPartners] = useState<Partner[]>([])
  const [partnersError, setPartnersError] = useState<string | null>(null)
  const [partnerId, setPartnerId] = useState<string>("")
  const [url, setUrl] = useState<string>("")
  const [running, setRunning] = useState(false)
  const [lastResult, setLastResult] = useState<CrawlRunFull | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch("/api/airtable/partners")
        const body = (await res.json()) as { partners?: Partner[]; error?: string }
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
        if (cancelled) return
        const list = (body.partners ?? [])
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name))
        setPartners(list)
      } catch (err) {
        if (cancelled) return
        setPartnersError(err instanceof Error ? err.message : "Failed to load partners")
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  async function handleRun() {
    setRunning(true)
    setLastResult(null)
    try {
      const body =
        mode === "partner"
          ? { partnerId, source: "manual" as const }
          : { url, source: "manual" as const }

      if (mode === "partner" && !partnerId) {
        toast.error("Pick a partner first")
        return
      }
      if (mode === "url" && !url.trim()) {
        toast.error("Enter a domain or URL")
        return
      }

      const t0 = Date.now()
      toast.message("Crawl started", {
        description: "This can take 3-7 minutes on a typical site.",
      })

      const res = await fetch("/api/technical-crawls/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const json = (await res.json()) as { run?: CrawlRunFull; error?: string }
      if (!res.ok || !json.run) {
        throw new Error(json.error ?? `HTTP ${res.status}`)
      }
      const seconds = Math.round((Date.now() - t0) / 1000)
      toast.success(`Crawl finished in ${seconds}s`)
      setLastResult(json.run)
      onCompleted?.(json.run)
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Crawl failed"
      toast.error(msg)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="space-y-6">
      <Tabs value={mode} onValueChange={(v) => setMode(v as "partner" | "url")}>
        <TabsList>
          <TabsTrigger value="partner">Partner</TabsTrigger>
          <TabsTrigger value="url">Custom URL</TabsTrigger>
        </TabsList>

        <TabsContent value="partner" className="mt-4 space-y-3">
          {partnersError ? (
            <p className="text-sm text-destructive" role="alert">
              {partnersError}
            </p>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="tc-partner">Partner</Label>
              <Select value={partnerId} onValueChange={setPartnerId} disabled={running}>
                <SelectTrigger id="tc-partner" className="w-full max-w-md">
                  <SelectValue placeholder="Select a partner…" />
                </SelectTrigger>
                <SelectContent>
                  {partners.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </TabsContent>

        <TabsContent value="url" className="mt-4 space-y-2">
          <Label htmlFor="tc-url">Domain or full URL</Label>
          <Input
            id="tc-url"
            placeholder="example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={running}
            className="max-w-md"
          />
          <p className="text-xs text-muted-foreground">
            No partner record needed. Result is persisted but not associated
            with any partner — find it in the History tab without a partner
            filter.
          </p>
        </TabsContent>
      </Tabs>

      <div>
        <Button onClick={handleRun} disabled={running}>
          {running ? "Crawling…" : "Run technical crawl"}
        </Button>
        <p className="mt-2 text-xs text-muted-foreground">
          Crawls ~50 pages of the target site, runs mobile Lighthouse on a
          5-page sample, and extracts JSON-LD from up to 16 representative
          pages. Typical runtime: 3-7 minutes.
        </p>
      </div>

      {lastResult ? (
        <div className="rounded-md border border-border bg-card p-4 text-sm">
          <p className="font-medium text-foreground">Crawl complete.</p>
          <p className="mt-1 text-muted-foreground">
            View it in the <b>History</b> tab — id <code>{lastResult.id}</code>.
          </p>
        </div>
      ) : null}
    </div>
  )
}
