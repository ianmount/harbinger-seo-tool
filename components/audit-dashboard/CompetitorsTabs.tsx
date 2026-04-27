"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"
import type { CompetitorsSection } from "@/lib/audit-dashboard-data"

export function CompetitorsTabs({ data }: { data: CompetitorsSection }) {
  const [active, setActive] = useState(data.locations[0]?.locationCode ?? 0)
  const current =
    data.locations.find((l) => l.locationCode === active) ?? data.locations[0]
  if (!current) return null
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1 border-b border-line">
        {data.locations.map((loc) => {
          const isActive = loc.locationCode === active
          return (
            <button
              key={loc.locationCode}
              type="button"
              onClick={() => setActive(loc.locationCode)}
              data-print-hide
              className={cn(
                "border-b-2 px-3 py-2 font-sans text-[11.5px] font-bold uppercase tracking-[0.14em] transition-colors",
                isActive
                  ? "border-brand-red text-foreground"
                  : "border-transparent text-ink-3 hover:text-foreground",
              )}
            >
              {loc.label}
            </button>
          )
        })}
      </div>
      {data.locations.map((loc) => (
        <div
          key={loc.locationCode}
          data-location-panel={loc.locationCode}
          className={cn(loc.locationCode === active ? "block" : "hidden")}
          data-print-show
        >
          <h3 className="font-sans text-[13px] font-bold uppercase tracking-[0.16em] text-ink-2">
            {loc.label}
          </h3>
          <div className="mt-3 overflow-x-auto rounded-[10px] border border-line">
            <table className="w-full border-collapse">
              <thead className="bg-brand-paper">
                <tr>
                  <th className="border-b border-line px-3 py-2.5 text-left font-sans text-[10.5px] font-bold uppercase tracking-[0.16em] text-ink-2">
                    Domain
                  </th>
                  <th className="border-b border-line px-3 py-2.5 text-right font-sans text-[10.5px] font-bold uppercase tracking-[0.16em] text-ink-2">
                    Traffic
                  </th>
                  <th className="border-b border-line px-3 py-2.5 text-right font-sans text-[10.5px] font-bold uppercase tracking-[0.16em] text-ink-2">
                    Top 3
                  </th>
                  <th className="border-b border-line px-3 py-2.5 text-right font-sans text-[10.5px] font-bold uppercase tracking-[0.16em] text-ink-2">
                    Top 10
                  </th>
                  <th className="border-b border-line px-3 py-2.5 text-right font-sans text-[10.5px] font-bold uppercase tracking-[0.16em] text-ink-2">
                    Ref Domains
                  </th>
                  <th className="border-b border-line px-3 py-2.5 text-right font-sans text-[10.5px] font-bold uppercase tracking-[0.16em] text-ink-2">
                    Pages
                  </th>
                </tr>
              </thead>
              <tbody>
                {loc.rows.map((r, i) => (
                  <tr
                    key={i}
                    className={cn(
                      "border-b border-line/70 last:border-b-0",
                      r.isPartner
                        ? "bg-brand-red/5"
                        : i % 2 === 0
                          ? "bg-card"
                          : "bg-brand-paper/40",
                    )}
                  >
                    <td className="px-3 py-2.5 font-serif text-[13.5px] text-foreground">
                      {r.isPartner ? <strong>{r.domain}</strong> : r.domain}
                      {r.isPartner ? (
                        <span className="ml-2 inline-block rounded-full bg-brand-red/15 px-2 py-0.5 font-sans text-[9.5px] font-bold uppercase tracking-[0.16em] text-brand-red-700">
                          Subject
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2.5 text-right font-sans font-semibold tabular-nums text-foreground">
                      {r.organicTraffic}
                    </td>
                    <td className="px-3 py-2.5 text-right font-sans font-semibold tabular-nums text-foreground">
                      {r.top3.toLocaleString()}
                    </td>
                    <td className="px-3 py-2.5 text-right font-sans font-semibold tabular-nums text-foreground">
                      {r.top10.toLocaleString()}
                    </td>
                    <td className="px-3 py-2.5 text-right font-sans font-semibold tabular-nums text-foreground">
                      {r.referringDomains.toLocaleString()}
                    </td>
                    <td className="px-3 py-2.5 text-right font-sans font-semibold tabular-nums text-foreground">
                      {r.pagesIndexed.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  )
}
