"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  findCategoryByPathname,
  TOOL_CATEGORIES,
  type ToolCategorySlug,
} from "@/lib/tool-config"
import { cn } from "@/lib/utils"

/**
 * SEMRush-style two-level navigation.
 *
 *   ┌──── primary ─────┬──── secondary ──────┐
 *   │ [icon] Keywords  │ ▸ Keyword Overview  │
 *   │ [icon] Backlinks │ ▸ Keyword Magic     │
 *   │ …                │                     │
 *   └──────────────────┴─────────────────────┘
 *
 * The primary column always lists the seven categories. Clicking one
 * expands the secondary column to show that category's tools. The
 * currently-active category (derived from the URL path) is highlighted
 * and its secondary is shown by default.
 */
export function SideNav() {
  const pathname = usePathname()

  const activeCategory = findCategoryByPathname(pathname)
  const [expanded, setExpanded] = useState<ToolCategorySlug | null>(
    activeCategory?.slug ?? null,
  )

  // Keep the expansion in sync with the URL: when the user navigates
  // through Next's router, the secondary should update without a click.
  useEffect(() => {
    if (activeCategory) setExpanded(activeCategory.slug)
  }, [activeCategory])

  const secondaryCategory =
    TOOL_CATEGORIES.find((c) => c.slug === expanded) ?? null

  return (
    <nav aria-label="Workflows" className="flex flex-1 overflow-hidden">
      {/* Primary column */}
      <ul className="flex w-[96px] shrink-0 flex-col overflow-y-auto border-r border-[color:var(--sidebar-border)] py-3">
        {TOOL_CATEGORIES.map((cat) => {
          const Icon = cat.icon
          const isActive = activeCategory?.slug === cat.slug
          const isExpanded = expanded === cat.slug
          return (
            <li key={cat.slug}>
              <button
                type="button"
                onClick={() => setExpanded(cat.slug)}
                aria-current={isActive ? "page" : undefined}
                aria-expanded={isExpanded}
                className={cn(
                  "flex w-full flex-col items-center gap-1 px-2 py-3 transition-colors",
                  "font-sans text-[9.5px] font-bold uppercase tracking-[0.1em]",
                  isActive
                    ? "bg-[color:var(--sidebar-accent)]/70 text-brand-cream"
                    : isExpanded
                      ? "bg-[color:var(--sidebar-accent)]/30 text-brand-cream"
                      : "text-[color:var(--sidebar-foreground)]/85 hover:bg-[color:var(--sidebar-accent)]/40 hover:text-brand-cream",
                )}
              >
                <Icon className="h-5 w-5" />
                <span className="text-center leading-tight">{cat.label}</span>
              </button>
            </li>
          )
        })}
      </ul>

      {/* Secondary column */}
      {secondaryCategory ? (
        <div className="flex w-[204px] flex-col overflow-y-auto py-3">
          <div className="px-4 pb-2">
            <p className="font-sans text-[10px] font-extrabold uppercase tracking-[0.18em] text-brand-cream/60">
              {secondaryCategory.label}
            </p>
          </div>
          <ul className="flex flex-col">
            {secondaryCategory.tools.map((tool) => {
              const isActive =
                pathname === tool.href || pathname?.startsWith(`${tool.href}/`)
              return (
                <li key={tool.slug}>
                  <Link
                    href={tool.href}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "relative block border-l-2 px-4 py-2 font-sans text-[11.5px] font-semibold tracking-tight transition-colors",
                      isActive
                        ? "border-brand-red bg-[color:var(--sidebar-accent)] text-brand-cream"
                        : "border-transparent text-[color:var(--sidebar-foreground)]/85 hover:bg-[color:var(--sidebar-accent)]/40 hover:text-brand-cream",
                    )}
                  >
                    {tool.label}
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
    </nav>
  )
}
