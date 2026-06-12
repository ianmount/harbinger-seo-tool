"use client"

import { useMemo, useState } from "react"
import { Check, Download, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import type { HeatmapPdfEntity } from "@/lib/heatmap-pdf"

/**
 * Export dialog for the GBP Heatmap. Lets the user pick which competitors to
 * include alongside the target, then builds a multi-page PDF (one snapshot per
 * business) client-side and triggers a download.
 */

export interface ExportCompetitor {
  key: string
  title: string
  rating: number | null
  ratingCount: number | null
  address: string | null
  lat: number | null
  lng: number | null
  ranks: (number | null)[]
}

export interface ExportTarget {
  title: string
  rating: number | null
  ratingCount: number | null
  address: string | null
  lat: number
  lng: number
  ranks: (number | null)[]
}

export function HeatmapExportDialog({
  open,
  onOpenChange,
  business,
  keyword,
  areaLabel,
  points,
  target,
  competitors,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  business: string
  keyword: string
  areaLabel: string
  points: { lat: number; lng: number }[]
  target: ExportTarget
  competitors: ExportCompetitor[]
}) {
  // Default: include the top few competitors (those with the broadest grid
  // presence are listed first), capped so the PDF stays focused.
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(competitors.slice(0, 3).map((c) => c.key)),
  )
  const [building, setBuilding] = useState(false)

  const selectableCompetitors = useMemo(
    () => competitors.filter((c) => c.lat != null && c.lng != null),
    [competitors],
  )

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  async function download() {
    setBuilding(true)
    try {
      const { buildHeatmapPdfBlob } = await import("@/lib/heatmap-pdf")
      const chosen = selectableCompetitors.filter((c) => selected.has(c.key))
      const blob = await buildHeatmapPdfBlob({
        business,
        keyword,
        areaLabel,
        generatedAt: new Date().toLocaleString(),
        points,
        target: {
          title: target.title,
          kind: "target",
          rating: target.rating,
          ratingCount: target.ratingCount,
          address: target.address,
          ranks: target.ranks,
          markerLat: target.lat,
          markerLng: target.lng,
        },
        competitors: chosen.map<HeatmapPdfEntity>((c) => ({
          title: c.title,
          kind: "competitor",
          rating: c.rating,
          ratingCount: c.ratingCount,
          address: c.address,
          ranks: c.ranks,
          markerLat: c.lat,
          markerLng: c.lng,
        })),
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      const slug = `${business}-${keyword}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
      a.download = `gbp-heatmap-${slug || "report"}.pdf`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      onOpenChange(false)
    } catch (err) {
      toast.error("Could not generate PDF", {
        description: err instanceof Error ? err.message : "Unknown error",
      })
    } finally {
      setBuilding(false)
    }
  }

  const count = 1 + selected.size

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Export heatmap PDF</DialogTitle>
          <DialogDescription>
            One page per business. Keyword{" "}
            <span className="font-semibold text-foreground">
              {keyword || "—"}
            </span>{" "}
            is shown on every page.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.08em] text-ink-3">
            Businesses to include
          </p>
          <ul className="max-h-[280px] space-y-1 overflow-y-auto pr-1">
            <li>
              <div className="flex items-center gap-2.5 rounded-md bg-muted/50 px-3 py-2">
                <CheckBox checked disabled />
                <span className="flex-1 text-sm font-medium">
                  {target.title}
                </span>
                <span className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700">
                  Target
                </span>
              </div>
            </li>
            {selectableCompetitors.map((c) => (
              <li key={c.key}>
                <button
                  type="button"
                  onClick={() => toggle(c.key)}
                  className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left transition-colors hover:bg-muted/40"
                >
                  <CheckBox checked={selected.has(c.key)} />
                  <span className="flex-1 truncate text-sm">{c.title}</span>
                  {c.rating != null ? (
                    <span className="font-mono text-[10px] text-ink-3">
                      ★ {c.rating.toFixed(1)}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
            {selectableCompetitors.length === 0 ? (
              <li className="px-3 py-2 font-serif text-[12px] text-ink-3">
                No competitors with map coordinates to include.
              </li>
            ) : null}
          </ul>
        </div>

        <DialogFooter className="sm:justify-between">
          <span className="self-center text-[11px] text-ink-3">
            {count} {count === 1 ? "page" : "pages"}
          </span>
          <Button type="button" onClick={download} disabled={building}>
            {building ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            {building ? "Generating…" : "Download PDF"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CheckBox({
  checked,
  disabled = false,
}: {
  checked: boolean
  disabled?: boolean
}) {
  return (
    <span
      className={cn(
        "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
        checked
          ? "border-primary bg-primary text-primary-foreground"
          : "border-input bg-background",
        disabled && "opacity-70",
      )}
    >
      {checked ? <Check className="h-3 w-3" strokeWidth={3} /> : null}
    </span>
  )
}
