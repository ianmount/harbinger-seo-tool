"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import {
  ChevronRightIcon,
  ExternalLinkIcon,
  FileTextIcon,
  Loader2Icon,
  TrashIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { getArtifactExternalPath } from "@/lib/partner-artifact-paths"
import type { PartnerArtifact, PartnerArtifactKind } from "@/lib/types"

interface KindOption {
  value: PartnerArtifactKind | "all"
  label: string
}

const KIND_OPTIONS: KindOption[] = [
  { value: "all", label: "All kinds" },
  { value: "keyword_list", label: "Keyword lists" },
  { value: "faq_research", label: "FAQ research" },
  { value: "strategy", label: "Strategy" },
  { value: "content_brief", label: "Content briefs" },
  { value: "content_copy", label: "Content copy" },
  { value: "backlink_prospects", label: "Backlink prospects" },
  { value: "outreach_drafts", label: "Outreach drafts" },
  { value: "report", label: "Reports" },
  { value: "technical_crawl", label: "Technical crawls" },
  { value: "competitive_analysis", label: "Competitive analysis" },
  { value: "audit", label: "Audits" },
]

const KIND_LABEL: Record<PartnerArtifactKind, string> = {
  keyword_list: "Keyword list",
  faq_research: "FAQ research",
  strategy: "Strategy",
  content_brief: "Content brief",
  content_copy: "Content copy",
  backlink_prospects: "Backlink prospects",
  outreach_drafts: "Outreach drafts",
  report: "Report",
  technical_crawl: "Technical crawl",
  competitive_analysis: "Competitive analysis",
  audit: "Audit",
}

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; artifacts: PartnerArtifact[] }

export function ArtifactsPanel({ partnerId }: { partnerId: string }) {
  const [filter, setFilter] = useState<KindOption["value"]>("all")
  const [state, setState] = useState<State>({ status: "loading" })
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    const ac = new AbortController()
    setState({ status: "loading" })

    async function load() {
      try {
        const url = new URL(
          `/api/partners/${encodeURIComponent(partnerId)}/artifacts`,
          window.location.origin,
        )
        if (filter !== "all") url.searchParams.set("kind", filter)
        const res = await fetch(url.toString(), { signal: ac.signal })
        const body = (await res.json()) as {
          artifacts?: PartnerArtifact[]
          error?: string
        }
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
        if (!cancelled)
          setState({ status: "ready", artifacts: body.artifacts ?? [] })
      } catch (err: unknown) {
        if (cancelled || (err instanceof Error && err.name === "AbortError"))
          return
        setState({
          status: "error",
          message:
            err instanceof Error ? err.message : "Failed to load artifacts",
        })
      }
    }
    load()
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [partnerId, filter, reloadKey])

  async function handleDelete(artifactId: string, title: string) {
    if (!confirm(`Delete "${title}"? This cannot be undone.`)) return
    try {
      const res = await fetch(
        `/api/partners/artifacts/${encodeURIComponent(artifactId)}`,
        { method: "DELETE" },
      )
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      toast.success("Artifact deleted")
      setReloadKey((k) => k + 1)
    } catch (err: unknown) {
      toast.error(
        err instanceof Error ? err.message : "Failed to delete artifact",
      )
    }
  }

  const grouped = useMemo(() => {
    if (state.status !== "ready") return null
    const map = new Map<PartnerArtifactKind, PartnerArtifact[]>()
    for (const a of state.artifacts) {
      const list = map.get(a.kind) ?? []
      list.push(a)
      map.set(a.kind, list)
    }
    return map
  }, [state])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Saved artifacts</h2>
          <p className="text-sm text-muted-foreground">
            Every tool output saved to this partner&rsquo;s folder.
          </p>
        </div>
        <Select
          value={filter}
          onValueChange={(v) => setFilter(v as KindOption["value"])}
        >
          <SelectTrigger className="w-[200px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {KIND_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {state.status === "loading" && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" />
          Loading…
        </div>
      )}

      {state.status === "error" && (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {state.message}
        </p>
      )}

      {state.status === "ready" && state.artifacts.length === 0 && (
        <div className="rounded-xl border border-dashed border-border p-8 text-center">
          <FileTextIcon className="mx-auto mb-2 size-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            {filter === "all"
              ? "No artifacts saved yet. Use any tool with this partner selected, then click “Save to partner” on the output."
              : `No ${KIND_OPTIONS.find((o) => o.value === filter)?.label.toLowerCase()} saved yet.`}
          </p>
        </div>
      )}

      {state.status === "ready" && grouped && state.artifacts.length > 0 && (
        <div className="space-y-6">
          {Array.from(grouped.entries()).map(([kind, items]) => (
            <div key={kind}>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {KIND_LABEL[kind] ?? kind} · {items.length}
              </h3>
              <ul className="divide-y divide-border rounded-lg border border-border">
                {items.map((a) => {
                  const externalPath = getArtifactExternalPath(a)
                  const detailHref = `/partners/${encodeURIComponent(partnerId)}/artifacts/${encodeURIComponent(a.id)}`
                  return (
                    <li
                      key={a.id}
                      className="group flex items-center gap-2 transition-colors hover:bg-muted/30"
                    >
                      <Link
                        href={detailHref}
                        className="flex min-w-0 flex-1 items-center gap-2 px-4 py-3"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">
                            {a.title}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {new Date(a.createdAt).toLocaleString()}
                          </p>
                        </div>
                        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                      </Link>
                      <div className="flex items-center gap-1 px-2">
                        {externalPath && (
                          <Button
                            asChild
                            variant="ghost"
                            size="sm"
                            title="Open full result"
                          >
                            <Link href={externalPath}>
                              <ExternalLinkIcon className="size-4 text-muted-foreground" />
                            </Link>
                          </Button>
                        )}
                        {a.blobUrl && !externalPath && (
                          <Button
                            asChild
                            variant="ghost"
                            size="sm"
                            title="Open blob file"
                          >
                            <a
                              href={a.blobUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <ExternalLinkIcon className="size-4 text-muted-foreground" />
                            </a>
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(a.id, a.title)}
                          aria-label={`Delete ${a.title}`}
                          title="Delete"
                        >
                          <TrashIcon className="size-4 text-muted-foreground" />
                        </Button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
