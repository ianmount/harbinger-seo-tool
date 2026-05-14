import Link from "next/link"
import { TOOL_CATEGORIES } from "@/lib/tool-config"

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
        {TOOL_CATEGORIES.map((cat) => {
          const Icon = cat.icon
          const firstHref = cat.tools[0]?.href ?? "/"
          const subtitle =
            cat.slug === "other"
              ? "Partner workflows and one-off jobs."
              : `${cat.tools.length} DataForSEO-powered tool${cat.tools.length === 1 ? "" : "s"}`
          return (
            <Link
              key={cat.slug}
              href={firstHref}
              className={cn(
                "group relative flex flex-col gap-5 overflow-hidden rounded-xl border border-line bg-gradient-to-br p-6 shadow-sm",
                "from-slate-500/10 to-slate-500/5",
                "transition-all duration-200 hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-lg",
              )}
            >
              <div className="inline-flex w-fit rounded-lg bg-foreground/5 p-3 text-foreground/80">
                <Icon className="h-6 w-6" />
              </div>
              <div className="flex flex-1 flex-col gap-2">
                <p className="font-sans text-[15px] font-extrabold tracking-[-0.01em] text-foreground">
                  {cat.label}
                </p>
                <p className="font-serif text-[13px] leading-relaxed text-foreground/60">
                  {subtitle}
                </p>
                <ul className="mt-2 flex flex-wrap gap-1">
                  {cat.tools.slice(0, 4).map((tool) => (
                    <li
                      key={tool.slug}
                      className="rounded-full bg-foreground/5 px-2 py-0.5 font-mono text-[10px] text-foreground/60"
                    >
                      {tool.label}
                    </li>
                  ))}
                  {cat.tools.length > 4 ? (
                    <li className="rounded-full bg-foreground/5 px-2 py-0.5 font-mono text-[10px] text-foreground/60">
                      +{cat.tools.length - 4} more
                    </li>
                  ) : null}
                </ul>
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
