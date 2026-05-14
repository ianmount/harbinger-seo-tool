"use client"

import type { ReactNode } from "react"
import { Card } from "@/components/ui/card"

/**
 * Standard layout wrapper for every tool page under the new SEMRush-style
 * nav. Tools render their input form into `form` and their results into
 * `results`. The shell takes care of heading, description, and the
 * card-around-form chrome.
 */
export function ToolShell({
  category,
  title,
  description,
  endpoints,
  form,
  results,
}: {
  category: string
  title: string
  description: string
  endpoints: readonly string[]
  form: ReactNode
  results: ReactNode
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

      <section aria-label="Results">{results}</section>

      {endpoints.length > 0 ? (
        <footer className="border-t border-dashed border-line pt-3">
          <p className="font-mono text-[10.5px] text-ink-3">
            DataForSEO endpoints:{" "}
            <span className="text-foreground/70">{endpoints[0]}</span>
            {endpoints.length > 1 ? (
              <span className="text-ink-3">
                {" "}
                · {endpoints.length - 1} more deferred
              </span>
            ) : null}
          </p>
        </footer>
      ) : null}
    </div>
  )
}
