import Link from "next/link"

const tabs = [
  { href: "/keyword-research", label: "Keyword Research" },
  { href: "/strategy", label: "Strategy" },
  { href: "/content", label: "Content Production" },
  { href: "/backlinks", label: "Backlinks" },
  { href: "/reporting", label: "Reporting" },
]

export default function Home() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">
        Harbinger SEO Tool
      </h1>
      <p className="text-muted-foreground">
        Internal tool for running the full 6-month SEO cycle for local service
        business partners. Five workflows wrap keyword research, strategy,
        content production, backlinks, and reporting.
      </p>
      <nav className="flex flex-col gap-2">
        {tabs.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            className="rounded-md border px-4 py-2 text-sm hover:bg-accent"
          >
            {tab.label}
          </Link>
        ))}
      </nav>
    </main>
  )
}
