import Link from "next/link"
import {
  ArrowRight,
  BarChart2,
  Clock,
  Code2,
  FileSearch,
  ImageIcon,
  Search,
  Target,
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
        description: "Pre-sales SEO audit → polished PDF report for prospects",
        icon: FileSearch,
      },
      {
        href: "/comp-analysis",
        label: "Comp Analysis",
        description: "Competitive landscape analysis and keyword gap identification",
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
        description: "View and manage all active partner accounts",
        icon: Users,
      },
      {
        href: "/strategy",
        label: "Strategy",
        description: "Generate and refine keyword strategy documents with Claude",
        icon: Target,
      },
    ],
  },
  {
    label: "Tools",
    items: [
      {
        href: "/keyword-research",
        label: "Keyword Research",
        description: "GSC queries + DataForSEO volume and difficulty scoring",
        icon: Search,
      },
      {
        href: "/scheduled-tasks",
        label: "Scheduled Tasks",
        description: "Manage recurring SEO tasks and automation runs",
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
        description: "Direct access to DataForSEO API endpoints for ad-hoc queries",
        icon: Code2,
      },
    ],
  },
]

export default function Home() {
  return (
    <div className="space-y-12 py-2">
      <header>
        <p className="eyebrow eyebrow-red">Harbinger · Internal</p>
        <h1 className="mt-2 font-serif text-[34px] font-medium italic leading-[1.08] tracking-[-0.01em] text-foreground">
          The SEO cycle,{" "}
          <b className="font-sans font-extrabold not-italic">end&#8209;to&#8209;end</b>, for every
          partner.
        </h1>
        <p className="mt-3 max-w-[600px] font-serif text-[15px] leading-relaxed text-ink-2">
          Choose a workflow below. Each section wraps one or more external APIs —{" "}
          <b className="font-sans font-extrabold text-foreground not-italic">DataForSEO</b>,{" "}
          <b className="font-sans font-extrabold text-foreground not-italic">GSC</b>,{" "}
          <b className="font-sans font-extrabold text-foreground not-italic">GA4</b>, and{" "}
          <b className="font-sans font-extrabold text-foreground not-italic">Claude</b> — and
          produces one artifact.
        </p>
      </header>

      <div className="space-y-10">
        {SECTIONS.map((section) => (
          <section key={section.label}>
            <div className="mb-4 border-t border-dashed border-line-strong pt-5">
              <h2 className="font-sans text-[10px] font-extrabold uppercase tracking-[0.22em] text-ink-3">
                {section.label}
              </h2>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {section.items.map((item) => {
                const Icon = item.icon
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="group flex flex-col gap-4 rounded-xl border border-line bg-card p-5 shadow-sm transition-all hover:border-brand-navy/25 hover:shadow-md"
                  >
                    <div className="flex items-start justify-between">
                      <div className="rounded-lg bg-brand-navy/8 p-2.5">
                        <Icon className="h-5 w-5 text-brand-navy" />
                      </div>
                      <ArrowRight className="mt-1 h-4 w-4 text-ink-3 transition-transform group-hover:translate-x-0.5" />
                    </div>
                    <div>
                      <h3 className="font-sans text-[14px] font-extrabold tracking-[-0.005em] text-foreground">
                        {item.label}
                      </h3>
                      <p className="mt-1 font-serif text-[13px] leading-snug text-ink-2">
                        {item.description}
                      </p>
                    </div>
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
