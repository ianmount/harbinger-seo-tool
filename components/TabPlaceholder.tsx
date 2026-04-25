"use client"

import { PageHeader } from "@/components/PageHeader"
import { Card, CardContent } from "@/components/ui/card"
import { useSelectedPartner } from "@/lib/use-selected-partner"

/**
 * Placeholder scaffolding shared by the five tab pages until each tab's
 * real workflow is built. Shows the selected partner's name + services or
 * prompts the user to pick one.
 */
export function TabPlaceholder({
  title,
  eyebrow = "Workflow",
  tail,
  subtitle,
}: {
  title: string
  eyebrow?: string
  tail?: string
  subtitle?: React.ReactNode
}) {
  const { partner, loading, error } = useSelectedPartner()

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={`${eyebrow} / ${title}`}
        title={title}
        tail={tail ?? "— coming soon."}
        subtitle={
          subtitle ?? (
            <>
              This tab's workflow is still on the roadmap. Pick a partner above
              to preview the active context.
            </>
          )
        }
      />

      {loading ? (
        <p className="font-serif text-[14px] italic text-ink-3">
          Loading partner…
        </p>
      ) : error ? (
        <Card className="border-l-[4px] border-l-destructive">
          <CardContent
            role="alert"
            className="font-serif text-[14px] text-destructive"
          >
            {error}
          </CardContent>
        </Card>
      ) : !partner ? (
        <Card>
          <CardContent className="font-serif text-[14px] italic text-ink-3">
            No partner selected. Choose one from the{" "}
            <b className="font-sans font-extrabold not-italic text-foreground">
              header dropdown
            </b>{" "}
            to begin.
          </CardContent>
        </Card>
      ) : (
        <Card className="border-l-[4px] border-l-brand-red">
          <CardContent className="space-y-4">
            <div>
              <p className="eyebrow">Partner</p>
              <h2 className="mt-2 font-sans text-[20px] font-extrabold tracking-[-0.005em]">
                {partner.name}
              </h2>
              {partner.serviceAreas ? (
                <p className="mt-1.5 font-serif text-[14px] italic text-ink-2">
                  {partner.serviceAreas}
                </p>
              ) : null}
            </div>
            {partner.services ? (
              <div>
                <p className="eyebrow">Services</p>
                <p className="mt-2 whitespace-pre-wrap font-serif text-[14px] leading-relaxed text-ink-2">
                  {partner.services}
                </p>
              </div>
            ) : null}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
