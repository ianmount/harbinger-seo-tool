import Link from "next/link"
import {
  BarChart2,
  Clock,
  Code2,
  FileSearch,
  ImageIcon,
  Search,
  Users,
} from "lucide-react"
import type { ComponentType } from "react"

type TileItem = {
  href: string
  label: string
  description: string
  icon: ComponentType<{ className?: string }>
  accent: string
  iconBg: string
}

const TILES: TileItem[] = [
  {
    href: "/partners",
    label: "Partner Dashboard",
    description: "View and manage active partner accounts, GSC and GA4 connections, and onboarding status.",
    icon: Users,
    accent: "from-sky-500/10 to-sky-500/5",
    iconBg: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  },
  {
    href: "/audit",
    label: "Audit",
    description: "Run a pre-sales SEO audit for a prospect domain and generate a polished PDF report.",
    icon: FileSearch,
    accent: "from-brand-red/10 to-brand-red/5",
    iconBg: "bg-brand-red/15 text-brand-red",
  },
  {
    href: "/comp-analysis",
    label: "Comp Analysis",
    description: "Map the competitive landscape, surface keyword gaps, and benchmark domain authority.",
    icon: BarChart2,
    accent: "from-violet-500/10 to-violet-500/5",
    iconBg: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  },
  {
    href: "/keyword-research",
    label: "Keyword Research",
    description: "Pull GSC queries alongside DataForSEO volume and difficulty to build a scored keyword list.",
    icon: Search,
    accent: "from-emerald-500/10 to-emerald-500/5",
    iconBg: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  },
  {
    href: "/tools/alt-tags",
    label: "Alt Tag Generation",
    description: "Batch-generate SEO-optimised alt text for images across a partner's site.",
    icon: ImageIcon,
    accent: "from-amber-500/10 to-amber-500/5",
    iconBg: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  },
  {
    href: "/tools/dataforseo",
    label: "DataForSEO APIs",
    description: "Direct access to DataForSEO endpoints for ad-hoc keyword, SERP, and backlink lookups.",
    icon: Code2,
    accent: "from-slate-500/10 to-slate-500/5",
    iconBg: "bg-slate-500/15 text-slate-600 dark:text-slate-400",
  },
  {
    href: "/scheduled-tasks",
    label: "Scheduled Tasks",
    description: "Manage recurring SEO automation jobs and review their run history.",
    icon: Clock,
    accent: "from-rose-500/10 to-rose-500/5",
    iconBg: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
  },
]

export default function Home() {
  return (
    <div className="space-y-10 py-2">
      <div className="space-y-1.5">
        <p className="font-sans text-[10px] font-extrabold uppercase tracking-[0.22em] text-foreground/40">
          Harbinger Marketing
        </p>
        <h1 className="font-sans text-[28px] font-extrabold tracking-[-0.02em] text-foreground">
          SEO Tool
        </h1>
        <p className="font-serif text-[14px] text-foreground/60">
          Full-cycle SEO platform for local service business partners.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {TILES.map((tile) => {
          const Icon = tile.icon
          return (
            <Link
              key={tile.href}
              href={tile.href}
              className={cn(
                "group relative flex flex-col gap-5 overflow-hidden rounded-xl border border-line bg-gradient-to-br p-6 shadow-sm",
                "transition-all duration-200 hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-lg",
                tile.accent,
              )}
            >
              <div className={`inline-flex w-fit rounded-lg p-3 ${tile.iconBg}`}>
                <Icon className="h-6 w-6" />
              </div>
              <div className="flex flex-1 flex-col gap-2">
                <p className="font-sans text-[15px] font-extrabold tracking-[-0.01em] text-foreground">
                  {tile.label}
                </p>
                <p className="font-serif text-[13px] leading-relaxed text-foreground/60">
                  {tile.description}
                </p>
              </div>
              <div className="flex items-center gap-1 font-sans text-[11px] font-bold uppercase tracking-[0.12em] text-foreground/40 transition-colors group-hover:text-foreground/60">
                Open
                <svg
                  className="h-3 w-3 transition-transform group-hover:translate-x-0.5"
                  fill="none"
                  viewBox="0 0 12 12"
                  stroke="currentColor"
                  strokeWidth={2.5}
                >
                  <path d="M2 6h8M6 2l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
            </Link>
          )
        })}
      </div>
    </div>
  )
}

function cn(...classes: (string | undefined | false)[]) {
  return classes.filter(Boolean).join(" ")
}
