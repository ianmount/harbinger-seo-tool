"use client"

import { useEffect, useState } from "react"
import { Menu, X } from "lucide-react"
import { cn } from "@/lib/utils"

export interface TocItem {
  id: string
  label: string
}

export function Toc({ items }: { items: TocItem[] }) {
  const [activeId, setActiveId] = useState<string | null>(items[0]?.id ?? null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible[0]) setActiveId(visible[0].target.id)
      },
      { rootMargin: "-20% 0% -70% 0%", threshold: 0 },
    )
    for (const item of items) {
      const el = document.getElementById(item.id)
      if (el) observer.observe(el)
    }
    return () => observer.disconnect()
  }, [items])

  function jumpTo(id: string) {
    const el = document.getElementById(id)
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" })
    setDrawerOpen(false)
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setDrawerOpen(true)}
        data-print-hide
        aria-label="Open table of contents"
        className="fixed bottom-6 right-6 z-30 inline-flex h-12 w-12 items-center justify-center rounded-full border border-line-strong bg-card text-foreground shadow-elev lg:hidden"
      >
        <Menu className="h-5 w-5" aria-hidden />
      </button>

      <aside
        data-print-hide
        className="hidden lg:sticky lg:top-28 lg:block lg:max-h-[calc(100vh-8rem)] lg:overflow-y-auto"
      >
        <p className="eyebrow eyebrow-red mb-3">Table of Contents</p>
        <nav>
          <ul className="space-y-1">
            {items.map((item) => (
              <li key={item.id}>
                <a
                  href={`#${item.id}`}
                  onClick={(e) => {
                    e.preventDefault()
                    jumpTo(item.id)
                  }}
                  className={cn(
                    "block rounded-md border-l-2 px-3 py-1.5 font-sans text-[12px] font-semibold tracking-[-0.005em] transition-colors",
                    activeId === item.id
                      ? "border-brand-red bg-brand-red/5 text-foreground"
                      : "border-transparent text-ink-2 hover:bg-brand-paper hover:text-foreground",
                  )}
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </aside>

      {drawerOpen ? (
        <div
          data-print-hide
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-40 bg-foreground/40 lg:hidden"
          onClick={() => setDrawerOpen(false)}
        >
          <div
            className="absolute right-0 top-0 h-full w-72 overflow-y-auto bg-card p-5 shadow-overlay"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <p className="eyebrow eyebrow-red">Sections</p>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close"
                className="rounded-md p-1 text-ink-2"
              >
                <X className="h-5 w-5" aria-hidden />
              </button>
            </div>
            <ul className="mt-4 space-y-1">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => jumpTo(item.id)}
                    className="block w-full rounded-md px-3 py-2 text-left font-sans text-[12.5px] font-semibold text-ink-2 hover:bg-brand-paper hover:text-foreground"
                  >
                    {item.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </>
  )
}
