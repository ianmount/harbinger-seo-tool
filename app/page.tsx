"use client"

import { useSelectedPartner } from "@/lib/use-selected-partner"

export default function Home() {
  const { partner, loading, error } = useSelectedPartner()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Harbinger SEO Tool
        </h1>
        <p className="mt-1 text-muted-foreground">
          Select a partner from the dropdown above, then pick a workflow tab.
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading partner…</p>
      ) : error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : partner ? (
        <section className="rounded-lg border p-4">
          <h2 className="text-lg font-medium">{partner.name}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {partner.serviceAreas}
          </p>
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">No partner selected.</p>
      )}
    </div>
  )
}
