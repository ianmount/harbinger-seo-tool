"use client"

import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import { cn } from "@/lib/utils"

type Tab = { href: string; label: string }

const TABS: Tab[] = [
  { href: "/partners", label: "Partner Dashboard" },
  { href: "/audit", label: "Audit" },
  { href: "/comp-analysis", label: "Comp Analysis" },
  { href: "/keyword-research", label: "Keyword Research" },
  { href: "/tools/alt-tags", label: "Alt Tag Generation" },
  { href: "/tools/dataforseo", label: "DataForSEO APIs" },
  { href: "/scheduled-tasks", label: "Scheduled Tasks" },
]

export function SideNav() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const query = searchParams.toString()
  const suffix = query ? `?${query}` : ""

  return (
    <nav aria-label="Workflows" className="flex flex-1 flex-col overflow-y-auto px-3 py-6">
      <ul className="flex flex-col">
        {TABS.map((tab) => {
          const active = pathname === tab.href
          return (
            <li key={tab.href}>
              <Link
                href={`${tab.href}${suffix}`}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative block border-l-2 px-3 py-2 font-sans text-[11.5px] font-bold uppercase tracking-[0.14em] transition-colors",
                  active
                    ? "border-brand-red bg-[color:var(--sidebar-accent)] text-brand-cream"
                    : "border-transparent text-[color:var(--sidebar-foreground)] hover:bg-[color:var(--sidebar-accent)]/40 hover:text-brand-cream",
                )}
              >
                {tab.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
