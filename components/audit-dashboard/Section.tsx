"use client"

import { useState, type ReactNode } from "react"
import { ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Collapsible dashboard section. Uses native semantics (button toggling
 * `aria-expanded`) so the print stylesheet can force every section open
 * via the `data-collapsed` attribute without relying on `<details>` quirks.
 */
export function Section({
  id,
  eyebrow,
  title,
  meta,
  defaultOpen = true,
  children,
}: {
  id: string
  eyebrow?: string
  title: string
  meta?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section
      id={id}
      data-section
      data-collapsed={!open}
      className="scroll-mt-28 rounded-[14px] border border-line bg-card shadow-card"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-section-toggle
        className="flex w-full items-center justify-between gap-4 px-6 py-5 text-left"
      >
        <div className="min-w-0">
          {eyebrow ? (
            <p className="eyebrow eyebrow-red mb-1.5">{eyebrow}</p>
          ) : null}
          <h2 className="font-sans text-[20px] font-extrabold tracking-[-0.005em] text-foreground">
            {title}
          </h2>
          {meta ? (
            <p className="mt-1 font-serif text-[13.5px] italic text-ink-2">
              {meta}
            </p>
          ) : null}
        </div>
        <ChevronDown
          className={cn(
            "h-5 w-5 shrink-0 text-ink-3 transition-transform",
            open ? "rotate-0" : "-rotate-90",
          )}
          aria-hidden
        />
      </button>
      {open ? (
        <div data-section-body className="border-t border-line px-6 py-6">
          {children}
        </div>
      ) : null}
    </section>
  )
}
