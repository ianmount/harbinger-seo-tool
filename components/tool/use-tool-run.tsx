"use client"

import { useState } from "react"

/**
 * Standard state machine shared by every tool page: input → POST →
 * `{ rows | error }`. Returns helpers wired so each tool page only has to
 * describe its own form JSX and render its `<ResultsTable>` with `rows`.
 */
export function useToolRun<Row>(endpoint: string) {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(body: unknown): Promise<void> {
    setError(null)
    setLoading(true)
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      const payload = (await res.json()) as { rows?: Row[]; error?: string }
      if (!res.ok) throw new Error(payload.error ?? `HTTP ${res.status}`)
      setRows(payload.rows ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed")
    } finally {
      setLoading(false)
    }
  }

  return { rows, loading, error, run, setError }
}

export function ToolError({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-destructive/50 bg-destructive/5 px-4 py-3 text-sm text-destructive">
      {message}
    </div>
  )
}
