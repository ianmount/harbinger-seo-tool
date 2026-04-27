"use client"

import { useState } from "react"
import { ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"
import type { CannibalizationSection } from "@/lib/audit-dashboard-data"

export function CannibalizationList({
  data,
}: {
  data: CannibalizationSection
}) {
  if (data.clusters.length === 0) {
    return (
      <p className="font-serif text-sm italic text-ink-3">
        No cannibalization clusters detected. Pages are not competing with each
        other for the same query/title.
      </p>
    )
  }
  return (
    <div className="space-y-3">
      <p className="font-serif text-[13.5px] italic text-ink-2">
        {data.clusters.length} cluster{data.clusters.length === 1 ? "" : "s"}{" "}
        — {data.totalUrls} total URLs.
      </p>
      <ul className="space-y-2">
        {data.clusters.map((c, i) => (
          <ClusterItem key={i} cluster={c} index={i + 1} />
        ))}
      </ul>
    </div>
  )
}

function ClusterItem({
  cluster,
  index,
}: {
  cluster: CannibalizationSection["clusters"][number]
  index: number
}) {
  const [open, setOpen] = useState(false)
  return (
    <li
      data-cluster
      data-collapsed={!open}
      className="overflow-hidden rounded-[10px] border border-line bg-card"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-cluster-toggle
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="min-w-0">
          <p className="font-sans text-[11px] font-bold uppercase tracking-[0.16em] text-ink-3">
            Cluster #{index} · {cluster.signalLabel}
          </p>
          <p className="mt-0.5 truncate font-serif text-[14px] text-foreground">
            {cluster.sharedTitle ?? cluster.topQuery ?? cluster.cluster[0]}
          </p>
          <p className="mt-1 font-serif text-[12.5px] italic text-ink-2">
            {cluster.cluster.length} pages · {cluster.recommendationLabel}
          </p>
        </div>
        <ChevronDown
          className={cn(
            "h-5 w-5 shrink-0 text-ink-3 transition-transform",
            open ? "rotate-0" : "-rotate-90",
          )}
          aria-hidden
        />
      </button>
      {open ? (
        <div className="border-t border-line bg-brand-paper/40 px-4 py-3">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className="px-2 py-1.5 text-left font-sans text-[10px] font-bold uppercase tracking-[0.16em] text-ink-3">
                  URL
                </th>
                <th className="px-2 py-1.5 text-right font-sans text-[10px] font-bold uppercase tracking-[0.16em] text-ink-3">
                  Clicks
                </th>
                <th className="px-2 py-1.5 text-right font-sans text-[10px] font-bold uppercase tracking-[0.16em] text-ink-3">
                  Impr
                </th>
                <th className="px-2 py-1.5 text-right font-sans text-[10px] font-bold uppercase tracking-[0.16em] text-ink-3">
                  Pos
                </th>
              </tr>
            </thead>
            <tbody>
              {cluster.urls.map((u, i) => (
                <tr key={i} className="border-t border-line/60">
                  <td className="break-all px-2 py-1.5 font-serif text-[12.5px] text-foreground">
                    <a
                      href={u.url}
                      target="_blank"
                      rel="noreferrer"
                      className="underline decoration-line decoration-1 underline-offset-2 hover:decoration-brand-red"
                    >
                      {u.url}
                    </a>
                  </td>
                  <td className="px-2 py-1.5 text-right font-sans tabular-nums text-foreground">
                    {u.clicks.toLocaleString()}
                  </td>
                  <td className="px-2 py-1.5 text-right font-sans tabular-nums text-ink-2">
                    {u.impressions.toLocaleString()}
                  </td>
                  <td className="px-2 py-1.5 text-right font-sans tabular-nums text-ink-2">
                    {u.position ? u.position.toFixed(1) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </li>
  )
}
