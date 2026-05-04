"use client"

import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import { cn } from "@/lib/utils"

type Tab = { href: string; label: string }

type Section = {
  key: "assessments" | "ongoing" | "tools"
  label: string
  tabs: Tab[]
}

const SECTIONS: Section[] = [
  {
    key: "assessments",
    label: "Assessments",
    tabs: [
      { href: "/audit", label: "Audit" },
      { href: "/comp-analysis", label: "Comp Analysis" },
    ],
  },
  {
    key: "ongoing",
    label: "Ongoing",
    tabs: [
      { href: "/partners", label: "Partner Dashboard" },
      { href: "/strategy", label: "Strategy" },
    ],
  },
  {
    key: "tools",
    label: "Tools",
    tabs: [
      { href: "/keyword-research", label: "Keyword Research" },
      { href: "/scheduled-tasks", label: "Scheduled Tasks" },
      { href: "/tools/alt-tags", label: "Alt Tag Generation" },
      { href: "/tools/dataforseo", label: "DataForSEO APIs" },
    ],
  },
]

export function SideNav() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const query = searchParams.toString()
  const suffix = query ? `?${query}` : ""

  return (
    <nav aria-label="Workflows" className="flex flex-1 flex-col gap-7 overflow-y-auto px-3 py-6">
      {SECTIONS.map((section) => {
        const isActiveSection = section.tabs.some((t) => t.href === pathname)
        return (
          <div key={section.key} className="flex flex-col gap-1.5">
            <span
              className={cn(
                "px-3 pb-1 font-sans text-[9.5px] font-extrabold uppercase tracking-[0.22em] transition-colors",
                isActiveSection
                  ? "text-brand-red"
                  : "text-[color:var(--sidebar-foreground)]/70",
              )}
            >
              {section.label}
            </span>
            <ul className="flex flex-col">
              {section.tabs.map((tab) => {
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
          </div>
        )
      })}
    </nav>
  )
}
