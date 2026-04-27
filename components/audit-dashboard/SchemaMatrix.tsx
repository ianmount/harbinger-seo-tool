"use client"

import { Fragment, useState } from "react"
import { ChevronDown, Check, X } from "lucide-react"
import { cn } from "@/lib/utils"
import type { SchemaSection } from "@/lib/audit-dashboard-data"

export function SchemaMatrix({ data }: { data: SchemaSection }) {
  const [openType, setOpenType] = useState<string | null>(null)
  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-[10px] border border-line">
        <table className="w-full border-collapse">
          <thead className="bg-brand-paper">
            <tr>
              <th className="border-b border-line px-3 py-2.5 text-left font-sans text-[10.5px] font-bold uppercase tracking-[0.16em] text-ink-2">
                Schema type
              </th>
              <th className="border-b border-line px-3 py-2.5 text-left font-sans text-[10.5px] font-bold uppercase tracking-[0.16em] text-ink-2 w-24">
                Status
              </th>
              <th className="border-b border-line px-3 py-2.5 text-left font-sans text-[10.5px] font-bold uppercase tracking-[0.16em] text-ink-2">
                Why it matters
              </th>
            </tr>
          </thead>
          <tbody>
            {data.matrix.map((row) => {
              const isOpen = openType === row.type
              return (
                <Fragment key={row.type}>
                  <tr
                    className="border-b border-line/70 last:border-b-0 even:bg-brand-paper/40"
                  >
                    <td className="px-3 py-2.5">
                      <button
                        type="button"
                        onClick={() =>
                          setOpenType(isOpen ? null : row.type)
                        }
                        data-print-hide
                        className="inline-flex items-center gap-2 font-sans text-[13px] font-semibold text-foreground"
                      >
                        <ChevronDown
                          className={cn(
                            "h-4 w-4 text-ink-3 transition-transform",
                            isOpen ? "rotate-0" : "-rotate-90",
                          )}
                          aria-hidden
                        />
                        {row.type}
                      </button>
                    </td>
                    <td className="px-3 py-2.5">
                      {row.present ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-success-light px-2.5 py-0.5 font-sans text-[10.5px] font-bold uppercase tracking-[0.14em] text-success-dark">
                          <Check className="h-3 w-3" aria-hidden /> Present
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-warning-light px-2.5 py-0.5 font-sans text-[10.5px] font-bold uppercase tracking-[0.14em] text-warning-dark">
                          <X className="h-3 w-3" aria-hidden /> Missing
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 font-serif text-[13px] text-ink-2">
                      {row.note}
                    </td>
                  </tr>
                  {isOpen ? (
                    <tr className="bg-brand-paper/60">
                      <td
                        colSpan={3}
                        className="px-3 py-3 font-serif text-[13px] text-ink-2"
                      >
                        {row.present
                          ? `Found on at least one crawled page. The crawler tracks distinct @type values across the site; subtypes (e.g. Plumber for LocalBusiness) are counted toward the requirement.`
                          : `Not detected on any crawled page. Add JSON-LD blocks emitting "@type": "${row.type}" on the page templates that match its purpose.`}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
      {data.typesPresent.length > 0 ? (
        <div>
          <p className="eyebrow mb-2">All types detected on the site</p>
          <div className="flex flex-wrap gap-1.5">
            {data.typesPresent.map((t) => (
              <span
                key={t}
                className="inline-flex rounded-full border border-line bg-card px-2.5 py-0.5 font-sans text-[10.5px] font-bold uppercase tracking-[0.14em] text-ink-2"
              >
                {t}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
