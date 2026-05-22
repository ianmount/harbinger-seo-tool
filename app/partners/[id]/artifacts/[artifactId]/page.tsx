"use client"

import { use, useEffect, useState } from "react"
import Link from "next/link"
import {
  ArrowLeftIcon,
  DownloadIcon,
  ExternalLinkIcon,
  Loader2Icon,
  TrashIcon,
} from "lucide-react"
import { toast } from "sonner"
import { PageHeader } from "@/components/PageHeader"
import { KeywordListView } from "@/components/partner-workspace/KeywordListView"
import { OnpageAuditView } from "@/components/tool/onpage/OnpageAuditView"
import type { AuditReport } from "@/lib/onpage-audit"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  ARTIFACT_KIND_LABEL,
  getArtifactExternalPath,
} from "@/lib/partner-artifact-paths"
import {
  getArtifactExports,
  type ArtifactExport,
} from "@/lib/partner-artifact-exports"
import type { Partner, PartnerArtifact } from "@/lib/types"

type PageState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; artifact: PartnerArtifact; partner: Partner | null }

export default function ArtifactDetailPage({
  params,
}: {
  params: Promise<{ id: string; artifactId: string }>
}) {
  const { id: partnerId, artifactId } = use(params)
  const [state, setState] = useState<PageState>({ status: "loading" })

  useEffect(() => {
    let cancelled = false
    const ac = new AbortController()
    async function load() {
      try {
        const [artifactRes, partnerRes] = await Promise.all([
          fetch(`/api/partners/artifacts/${encodeURIComponent(artifactId)}`, {
            signal: ac.signal,
          }),
          fetch(`/api/partners/${encodeURIComponent(partnerId)}`, {
            signal: ac.signal,
          }),
        ])
        const artifactBody = (await artifactRes.json()) as {
          artifact?: PartnerArtifact
          error?: string
        }
        if (!artifactRes.ok || !artifactBody.artifact) {
          throw new Error(artifactBody.error ?? "Artifact not found")
        }
        const partnerBody = (await partnerRes.json().catch(() => ({}))) as {
          partner?: Partner
        }
        if (!cancelled) {
          setState({
            status: "ready",
            artifact: artifactBody.artifact,
            partner: partnerBody.partner ?? null,
          })
        }
      } catch (err: unknown) {
        if (cancelled || (err instanceof Error && err.name === "AbortError"))
          return
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "Failed to load",
        })
      }
    }
    load()
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [partnerId, artifactId])

  async function handleDelete() {
    if (state.status !== "ready") return
    if (
      !confirm(
        `Delete "${state.artifact.title}"? This cannot be undone.`,
      )
    )
      return
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
      window.location.href = `/partners/${partnerId}?tab=artifacts`
    } catch (err: unknown) {
      toast.error(
        err instanceof Error ? err.message : "Failed to delete artifact",
      )
    }
  }

  function handleExport(spec: ArtifactExport) {
    try {
      const blob = new Blob([spec.build()], { type: spec.mimeType })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = spec.filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err: unknown) {
      toast.error(
        err instanceof Error ? err.message : "Failed to build export",
      )
    }
  }

  function handlePrintPdf() {
    if (state.status !== "ready") return
    // Hint the browser's print dialog to suggest a sensible filename. The
    // CSS in globals.css under `body[data-printing-artifact="1"]` hides
    // every non-artifact element so what prints matches the rendered view.
    const originalTitle = document.title
    document.title = state.artifact.title
    document.body.setAttribute("data-printing-artifact", "1")
    const reset = () => {
      document.body.removeAttribute("data-printing-artifact")
      document.title = originalTitle
      window.removeEventListener("afterprint", reset)
    }
    window.addEventListener("afterprint", reset)
    try {
      window.print()
    } catch {
      reset()
    }
  }

  if (state.status === "loading") {
    return (
      <div className="space-y-6">
        <div className="h-6 w-40 animate-pulse rounded bg-muted" />
        <div className="h-32 animate-pulse rounded-lg border bg-muted/30" />
      </div>
    )
  }

  if (state.status === "error") {
    return (
      <div className="space-y-4">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href={`/partners/${partnerId}?tab=artifacts`}>
            <ArrowLeftIcon className="mr-1.5 size-4" />
            Back to artifacts
          </Link>
        </Button>
        <p className="text-sm text-destructive">{state.message}</p>
      </div>
    )
  }

  const { artifact, partner } = state
  const externalPath = getArtifactExternalPath(artifact)
  const kindLabel = ARTIFACT_KIND_LABEL[artifact.kind] ?? artifact.kind
  const exports = getArtifactExports(artifact)

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href={`/partners/${partnerId}?tab=artifacts`}>
          <ArrowLeftIcon className="mr-1.5 size-4" />
          {partner ? `${partner.name} · Artifacts` : "Back to artifacts"}
        </Link>
      </Button>

      <PageHeader
        eyebrow={`Partners / Artifacts / ${kindLabel}`}
        title={artifact.title}
        subtitle={
          <span className="text-sm text-muted-foreground">
            Saved{" "}
            {new Date(artifact.createdAt).toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </span>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        {externalPath && (
          <Button asChild>
            <Link href={externalPath}>
              <ExternalLinkIcon className="mr-1.5 size-4" />
              Open full result
            </Link>
          </Button>
        )}
        {artifact.blobUrl && (
          <Button asChild variant="outline">
            <a
              href={artifact.blobUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLinkIcon className="mr-1.5 size-4" />
              Open blob file
            </a>
          </Button>
        )}
        <Button variant="outline" onClick={handlePrintPdf}>
          <DownloadIcon className="mr-1.5 size-4" />
          Save as PDF
        </Button>
        {exports.map((spec) => (
          <Button
            key={spec.format}
            variant="outline"
            onClick={() => handleExport(spec)}
          >
            <DownloadIcon className="mr-1.5 size-4" />
            {spec.label}
          </Button>
        ))}
        <Button
          variant="ghost"
          onClick={handleDelete}
          className="text-destructive hover:text-destructive"
        >
          <TrashIcon className="mr-1.5 size-4" />
          Delete
        </Button>
      </div>

      <Separator />

      <div className="artifact-print-root">
        <ArtifactBody artifact={artifact} />
      </div>
    </div>
  )
}

function ArtifactBody({ artifact }: { artifact: PartnerArtifact }) {
  // Per-kind rendering. Each branch returns either the rich view + a
  // collapsible raw-JSON panel, or falls through to the JSON-only view.
  if (artifact.kind === "keyword_list") {
    return (
      <>
        <KeywordListView data={artifact.data} />
        <RawDataDetails value={artifact.data} />
      </>
    )
  }
  if (artifact.kind === "onpage_audit") {
    const report = parseAuditReport(artifact.data)
    if (report) {
      return (
        <>
          <OnpageAuditView data={report} />
          <RawDataDetails value={artifact.data} />
        </>
      )
    }
  }
  return <JsonView value={artifact.data} />
}

function RawDataDetails({ value }: { value: unknown }) {
  let pretty: string
  try {
    pretty = JSON.stringify(value, null, 2)
  } catch {
    pretty = String(value)
  }
  return (
    <details className="group mt-6">
      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground">
        Raw data (click to expand)
      </summary>
      <pre className="mt-2 max-h-[400px] overflow-auto rounded-lg border border-border bg-muted/30 p-4 text-xs leading-relaxed">
        {pretty}
      </pre>
    </details>
  )
}

/**
 * The on-page audit save spec wraps the raw `AuditReport` with a couple
 * of metadata fields (`target`, `capturedAt`) and then spreads the
 * report. This narrows the saved blob back to an `AuditReport` shape
 * for the view component. Returns null if the payload looks unusable
 * so we fall back to the raw JSON view.
 */
function parseAuditReport(value: unknown): AuditReport | null {
  if (typeof value !== "object" || value === null) return null
  const obj = value as Record<string, unknown>
  if (
    typeof obj.health !== "number" ||
    typeof obj.totals !== "object" ||
    !Array.isArray(obj.byCategory) ||
    !Array.isArray(obj.topIssues) ||
    !Array.isArray(obj.perUrl) ||
    !Array.isArray(obj.schema)
  ) {
    return null
  }
  return obj as unknown as AuditReport
}

function JsonView({ value }: { value: unknown }) {
  let pretty: string
  try {
    pretty = JSON.stringify(value, null, 2)
  } catch {
    pretty = String(value)
  }
  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Raw data
      </p>
      <pre className="max-h-[600px] overflow-auto rounded-lg border border-border bg-muted/30 p-4 text-xs leading-relaxed">
        {pretty}
      </pre>
    </div>
  )
}
