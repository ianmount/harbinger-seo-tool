"use client"

import { Card, CardContent } from "@/components/ui/card"
import { useSelectedPartner } from "@/lib/use-selected-partner"

export default function Home() {
  const { partner, loading, error } = useSelectedPartner()

  return (
    <div className="space-y-10">
      <header>
        <p className="eyebrow eyebrow-red">Harbinger · Internal</p>
        <h1 className="mt-2 font-serif text-[34px] font-medium italic leading-[1.08] tracking-[-0.01em] text-foreground">
          The SEO cycle, <b className="font-sans font-extrabold not-italic">end&#8209;to&#8209;end</b>, for every partner.
        </h1>
        <p className="mt-3 max-w-[640px] font-serif text-[15.5px] leading-relaxed text-ink-2">
          Pick a partner from the header, then choose a workflow tab. Each tab wraps one external API — <b className="font-sans font-extrabold text-foreground not-italic">DataForSEO</b>, <b className="font-sans font-extrabold text-foreground not-italic">GSC</b>, <b className="font-sans font-extrabold text-foreground not-italic">GA4</b>, and <b className="font-sans font-extrabold text-foreground not-italic">Claude</b> — and produces one artifact.
        </p>
      </header>

      <section>
        <div className="mb-5 flex items-baseline gap-3.5 border-t border-dashed border-line-strong pt-6">
          <span className="font-serif text-[13px] italic font-medium text-brand-red">
            § 01
          </span>
          <h2 className="font-sans text-[18px] font-extrabold tracking-[-0.005em]">
            Active partner
          </h2>
        </div>

        {loading ? (
          <p className="font-serif text-[14px] italic text-ink-3">
            Loading partner…
          </p>
        ) : error ? (
          <Card className="border-l-[4px] border-l-destructive">
            <CardContent className="font-serif text-[14px] text-destructive" role="alert">
              {error}
            </CardContent>
          </Card>
        ) : partner ? (
          <Card className="border-l-[4px] border-l-brand-red">
            <CardContent>
              <p className="eyebrow">Partner</p>
              <h3 className="mt-2 font-sans text-[22px] font-extrabold tracking-[-0.005em] normal-case">
                {partner.name}
              </h3>
              {partner.serviceAreas ? (
                <p className="mt-2 font-serif text-[14px] italic text-ink-2">
                  {partner.serviceAreas}
                </p>
              ) : null}
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="font-serif text-[14px] italic text-ink-3">
              No partner selected. Choose one from the <b className="font-sans font-extrabold text-foreground not-italic">header dropdown</b> to begin.
            </CardContent>
          </Card>
        )}
      </section>
    </div>
  )
}
