"use client"

import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import { cn } from "@/lib/utils"

const TABS = [
  { href: "/audit", label: "Audit" },
  { href: "/keyword-research", label: "Keyword Research" },
  { href: "/strategy", label: "Strategy" },
  { href: "/content", label: "Content" },
  { href: "/backlinks", label: "Backlinks" },
  { href: "/reporting", label: "Reporting" },
] as const

export function TabNav() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const query = searchParams.toString()
  const suffix = query ? `?${query}` : ""

  return (
    <nav
      aria-label="Workflows"
      className="border-b border-border bg-brand-paper"
    >
      <div className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4 sm:px-6">
        {TABS.map((tab) => {
          const active = pathname === tab.href
          return (
            <Link
              key={tab.href}
              href={`${tab.href}${suffix}`}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative -mb-px whitespace-nowrap border-b-2 px-3 py-3.5 font-sans text-[11.5px] font-bold uppercase tracking-[0.14em] transition-colors",
                active
                  ? "border-brand-red text-foreground"
                  : "border-transparent text-ink-3 hover:text-foreground",
              )}
            >
              {tab.label}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
