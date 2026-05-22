"use client"

import type { ReactNode } from "react"
import { useSearchParams } from "next/navigation"
import { Card } from "@/components/ui/card"
import type { ToolRunMeta } from "@/components/tool/use-tool-run"
import { SaveToPartnerButton } from "@/components/SaveToPartnerButton"
import type { PartnerArtifactKind } from "@/lib/types"

export interface ToolSaveSpec {
  /** Which artifact kind this tool's output maps to. */
  kind: PartnerArtifactKind
  /** Lazy default title for the Save dialog. */
  getDefaultTitle: () => string
  /** Lazy payload captured at click time. Return null/undefined to disable. */
  getData: () => unknown | Promise<unknown>
  /**
   * When false, the Save button is hidden. Tools set this based on
   * whether their `useToolRun` has data yet.
   */
  enabled: boolean
}

/**
 * Standard layout wrapper for every tool page. Tools render their input
 * form into `form` and their results into `results`. The shell takes
 * care of heading, description, the card-around-form chrome, and an
 * optional "Save to partner" button that appears above the results
 * area whenever the tool declares `save` with `enabled: true`.
 *
 * The footer reports the DFSEO endpoints from `tool-config.ts` (what
 * the tool is *supposed* to hit) and, once a run has completed, the
 * actual endpoints hit + cost + duration from the response meta.
 */
export function ToolShell({
  category,
  title,
  description,
  endpoints,
  form,
  results,
  meta,
  save,
}: {
  category: string
  title: string
  description: string
  endpoints: readonly string[]
  form: ReactNode
  results: ReactNode
  meta?: ToolRunMeta | null
  save?: ToolSaveSpec
}) {
  return (
    <div className="space-y-6">
      <header className="space-y-1.5">
        <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink-3">
          {category}
        </p>
        <h1 className="font-sans text-[24px] font-extrabold tracking-[-0.015em] text-foreground">
          {title}
        </h1>
        <p className="font-serif text-[14px] text-ink-2">{description}</p>
      </header>

      <Card className="p-5">{form}</Card>

      {save?.enabled && <ToolShellSaveBar save={save} />}

      <div className="space-y-6" aria-label="Results">
        {results}
      </div>

      <footer className="space-y-1 border-t border-dashed border-line pt-3 print:hidden">
        <p className="font-mono text-[10.5px] text-ink-3">
          Spec endpoints ({endpoints.length}):{" "}
          <span className="text-foreground/70">{endpoints.join("  ·  ")}</span>
        </p>
        {meta ? (
          <p className="font-mono text-[10.5px] text-ink-3">
            Last run: {meta.endpoints.length} endpoint
            {meta.endpoints.length === 1 ? "" : "s"} hit
            {typeof meta.costUsd === "number"
              ? ` · $${meta.costUsd.toFixed(4)}`
              : ""}
            {typeof meta.durationMs === "number"
              ? ` · ${(meta.durationMs / 1000).toFixed(1)}s`
              : ""}
          </p>
        ) : null}
      </footer>
    </div>
  )
}

/**
 * Tiny client-only strip that holds the Save button. Reads the
 * currently-selected partner from the URL (`?partnerId=…`) so the
 * dialog's partner dropdown is pre-filled when the user navigated here
 * from a partner workspace.
 */
function ToolShellSaveBar({ save }: { save: ToolSaveSpec }) {
  const params = useSearchParams()
  const partnerId = params.get("partnerId")
  return (
    <div className="flex items-center justify-end">
      <SaveToPartnerButton
        kind={save.kind}
        defaultTitle={save.getDefaultTitle()}
        getData={save.getData}
        partnerId={partnerId}
        variant="outline"
      />
    </div>
  )
}
