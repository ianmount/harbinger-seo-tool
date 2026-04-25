"use client"

import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import { cn } from "@/lib/utils"

type Tab = { href: string; label: string }

type Category = {
  key: "assessments" | "onboarding" | "ongoing"
  label: string
  tabs: Tab[]
}

const CATEGORIES: Category[] = [
  {
    key: "assessments",
    label: "Assessments",
    tabs: [
      { href: "/audit", label: "Audit" },
      { href: "/comp-analysis", label: "Comp Analysis" },
    ],
  },
  {
    key: "onboarding",
    label: "Onboarding",
    tabs: [],
  },
  {
    key: "ongoing",
    label: "Ongoing",
    tabs: [
      { href: "/keyword-research", label: "Keyword Research" },
      { href: "/strategy", label: "Strategy" },
      { href: "/content", label: "Content" },
      { href: "/backlinks", label: "Backlinks" },
      { href: "/reporting", label: "Reporting" },
    ],
  },
]

function activeCategory(pathname: string): Category["key"] | null {
  if (pathname === "/onboarding") return "onboarding"
  for (const cat of CATEGORIES) {
    if (cat.tabs.some((t) => t.href === pathname)) return cat.key
  }
  return null
}

export function TabNav() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const query = searchParams.toString()
  const suffix = query ? `?${query}` : ""
  const currentCategory = activeCategory(pathname)

  return (
    <nav
      aria-label="Workflows"
      className="border-b border-border bg-brand-paper"
    >
      <div className="mx-auto flex max-w-6xl items-stretch gap-6 overflow-x-auto px-4 sm:gap-8 sm:px-6">
        {CATEGORIES.map((category, idx) => {
          const isActiveCategory = currentCategory === category.key
          return (
            <div
              key={category.key}
              className={cn(
                "flex min-w-0 flex-col py-2",
                idx > 0 && "border-l border-line-strong/50 pl-6 sm:pl-8",
              )}
            >
              <span
                className={cn(
                  "px-1 pb-0.5 font-sans text-[9.5px] font-extrabold uppercase tracking-[0.22em] transition-colors",
                  isActiveCategory ? "text-brand-red" : "text-ink-3",
                )}
              >
                {category.label}
              </span>
              <div className="-mb-px flex items-stretch gap-1">
                {category.tabs.length === 0 ? (
                  <Link
                    href="/onboarding"
                    aria-current={pathname === "/onboarding" ? "page" : undefined}
                    className={cn(
                      "relative whitespace-nowrap border-b-2 px-3 py-2 font-serif text-[12.5px] italic transition-colors",
                      pathname === "/onboarding"
                        ? "border-brand-red text-foreground"
                        : "border-transparent text-ink-3 hover:text-foreground",
                    )}
                  >
                    Coming soon
                  </Link>
                ) : (
                  category.tabs.map((tab) => {
                    const active = pathname === tab.href
                    return (
                      <Link
                        key={tab.href}
                        href={`${tab.href}${suffix}`}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "relative whitespace-nowrap border-b-2 px-3 py-2 font-sans text-[11.5px] font-bold uppercase tracking-[0.14em] transition-colors",
                          active
                            ? "border-brand-red text-foreground"
                            : "border-transparent text-ink-3 hover:text-foreground",
                        )}
                      >
                        {tab.label}
                      </Link>
                    )
                  })
                )}
              </div>
            </div>
          )
        })}
      </div>
    </nav>
  )
}
