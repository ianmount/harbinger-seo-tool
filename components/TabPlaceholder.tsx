"use client"

import { useSelectedPartner } from "@/lib/use-selected-partner"

/**
 * Placeholder scaffolding shared by the five tab pages until each tab's
 * real workflow is built. Shows the selected partner's name + services or
 * prompts the user to pick one.
 */
export function TabPlaceholder({ title }: { title: string }) {
  const { partner, loading, error } = useSelectedPartner()

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading partner…</p>
      ) : error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : !partner ? (
        <p className="text-sm text-muted-foreground">
          Please select a partner from the dropdown above.
        </p>
      ) : (
        <section className="space-y-3 rounded-lg border p-4">
          <div>
            <h2 className="text-lg font-medium">{partner.name}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {partner.serviceAreas}
            </p>
          </div>
          <div>
            <h3 className="text-sm font-medium">Services</h3>
            <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
              {partner.services}
            </p>
          </div>
        </section>
      )}
    </div>
  )
}
