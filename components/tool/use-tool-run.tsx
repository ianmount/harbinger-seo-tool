"use client"

import { useState, type ReactNode } from "react"

/**
 * Standard state machine shared by every tool page. Generic over the
 * response payload shape — single-table tools have `data: { rows: Row[] }`,
 * multi-section tools have whatever keyed shape their API route returns.
 */
export function useToolRun<TData>(endpoint: string) {
  const [data, setData] = useState<TData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [meta, setMeta] = useState<ToolRunMeta | null>(null)

  async function run(body: unknown): Promise<void> {
    setError(null)
    setLoading(true)
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      const payload = (await res.json()) as {
        data?: TData
        meta?: ToolRunMeta
        error?: string
      }
      if (!res.ok) throw new Error(payload.error ?? `HTTP ${res.status}`)
      setData(payload.data ?? null)
      setMeta(payload.meta ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed")
    } finally {
      setLoading(false)
    }
  }

  return { data, meta, loading, error, run, setError }
}

export type ToolRunMeta = {
  endpoints: readonly string[]
  costUsd?: number
  durationMs: number
}

export function ToolError({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-destructive/50 bg-destructive/5 px-4 py-3 text-sm text-destructive">
      {message}
    </div>
  )
}

/**
 * Section heading + children wrapper used by multi-table tool pages.
 * Keeps the page JSX tidy when stacking 3-5 `<ResultsTable>` blocks.
 */
export function ToolSection({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: ReactNode
}) {
  return (
    <section className="space-y-2">
      <div className="space-y-0.5">
        <h2 className="font-sans text-[13px] font-extrabold uppercase tracking-[0.14em] text-foreground/85">
          {title}
        </h2>
        {description ? (
          <p className="font-serif text-[12.5px] text-ink-3">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  )
}
