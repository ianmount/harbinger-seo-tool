import Link from "next/link"
import {
  ArrowRight,
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
}

type TileSection = {
  label: string
  items: TileItem[]
}

const SECTIONS: TileSection[] = [
  {
    label: "Assessments",
    items: [
      {
        href: "/audit",
        label: "Audit",
        description: "Pre-sales SEO audit → polished PDF report",
        icon: FileSearch,
      },
      {
        href: "/comp-analysis",
        label: "Comp Analysis",
        description: "Competitive landscape and keyword gap analysis",
        icon: BarChart2,
      },
    ],
  },
  {
    label: "Ongoing",
    items: [
      {
        href: "/partners",
        label: "Partner Dashboard",
        description: "View and manage active partner accounts",
        icon: Users,
      },
    ],
  },
  {
    label: "Tools",
    items: [
      {
        href: "/keyword-research",
        label: "Keyword Research",
        description: "GSC queries + DataForSEO volume and difficulty",
        icon: Search,
      },
      {
        href: "/scheduled-tasks",
        label: "Scheduled Tasks",
        description: "Manage recurring SEO tasks and automation",
        icon: Clock,
      },
      {
        href: "/tools/alt-tags",
        label: "Alt Tag Generation",
        description: "Batch-generate SEO-optimised alt text for images",
        icon: ImageIcon,
      },
      {
        href: "/tools/dataforseo",
        label: "DataForSEO APIs",
        description: "Direct access to DataForSEO API endpoints",
        icon: Code2,
      },
    ],
  },
]

export default function Home() {
  return (
    <div className="space-y-8 py-2">
      <h1 className="font-sans text-[22px] font-extrabold tracking-[-0.005em] text-foreground">
        Harbinger SEO Tool
      </h1>

      <div className="space-y-6">
        {SECTIONS.map((section) => (
          <section key={section.label}>
            <h2 className="mb-3 font-sans text-[10px] font-extrabold uppercase tracking-[0.22em] text-ink-3">
              {section.label}
            </h2>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {section.items.map((item) => {
                const Icon = item.icon
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="group flex items-center gap-3 rounded-lg border border-line bg-card px-4 py-3 shadow-sm transition-all hover:border-foreground/25 hover:shadow-md"
                  >
                    <div className="shrink-0 rounded-md bg-foreground/8 p-1.5">
                      <Icon className="h-4 w-4 text-foreground/70" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-sans text-[13px] font-extrabold tracking-[-0.005em] text-foreground">
                        {item.label}
                      </p>
                      <p className="mt-0.5 truncate font-serif text-[11.5px] text-ink-3">
                        {item.description}
                      </p>
                    </div>
                    <ArrowRight className="ml-auto h-3.5 w-3.5 shrink-0 text-ink-3 transition-transform group-hover:translate-x-0.5" />
                  </Link>
                )
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
