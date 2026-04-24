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
    <nav className="border-b bg-background">
      <div className="mx-auto flex max-w-6xl gap-1 px-4 overflow-x-auto">
        {TABS.map((tab) => {
          const active = pathname === tab.href
          return (
            <Link
              key={tab.href}
              href={`${tab.href}${suffix}`}
              aria-current={active ? "page" : undefined}
              className={cn(
                "whitespace-nowrap border-b-2 px-3 py-3 text-sm font-medium transition-colors",
                active
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
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
