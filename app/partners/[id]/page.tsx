"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { use } from "react"
import { ArrowLeftIcon, ExternalLinkIcon } from "lucide-react"
import { DfseoActionsPanel } from "@/components/partner-dashboard/DfseoActionsPanel"
import { PartnerReportSection } from "@/components/partner-dashboard/PartnerReportSection"
import { ScheduledTaskHistory } from "@/components/partner-dashboard/ScheduledTaskHistory"
import { PageHeader } from "@/components/PageHeader"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import type { Partner, PartnerSnapshot } from "@/lib/types"

function MetricCard({
  label,
  value,
  sub,
}: {
  label: string
  value: string
  sub?: string
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 font-mono text-2xl font-semibold tabular-nums">{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  )
}

function fmt(n: number, decimals = 0): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toFixed(decimals)
}

function fmtDelta(cur: number | null, prior: number | null): string | null {
  if (cur === null || prior === null || prior === 0) return null
  const pct = ((cur - prior) / prior) * 100
  const sign = pct >= 0 ? "+" : ""
  return `${sign}${pct.toFixed(0)}% vs prior`
}

type SnapshotState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | ({ status: "done" } & Pick<
      PartnerSnapshot,
      "partner" | "current" | "prior" | "ga4" | "gscSiteUrl" | "ga4PropertyId"
    >)

export default function PartnerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  const [state, setState] = useState<SnapshotState>({ status: "loading" })

  useEffect(() => {
    async function loadPartner() {
      try {
        // Fetch partner record
        const partnerRes = await fetch(`/api/airtable/partner/${encodeURIComponent(id)}`)
        const partnerBody = (await partnerRes.json()) as {
          partner?: Partner
          error?: string
        }
        if (!partnerRes.ok || !partnerBody.partner) {
          throw new Error(partnerBody.error ?? "Partner not found")
        }
        const partner = partnerBody.partner

        // Fetch snapshot for the default 28-day window (for the metrics cards)
        const today = new Date()
        const endDate = iso(today)
        const startDate = iso(new Date(today.getTime() - 27 * 86_400_000))
        const snapRes = await fetch(
          `/api/partners/snapshot?startDate=${startDate}&endDate=${endDate}`,
          { cache: "no-store" },
        )
        if (snapRes.ok) {
          const snapBody = (await snapRes.json()) as {
            snapshots?: PartnerSnapshot[]
          }
          const snap = snapBody.snapshots?.find((s) => s.partner.id === id)
          if (snap) {
            setState({
              status: "done",
              partner,
              current: snap.current,
              prior: snap.prior,
              ga4: snap.ga4,
              gscSiteUrl: snap.gscSiteUrl,
              ga4PropertyId: snap.ga4PropertyId,
            })
            return
          }
        }

        // Fallback if snapshot doesn't include this partner yet
        setState({
          status: "done",
          partner,
          current: null,
          prior: null,
          ga4: null,
          gscSiteUrl: null,
          ga4PropertyId: null,
        })
      } catch (err) {
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "Failed to load partner",
        })
      }
    }
    loadPartner()
  }, [id])

  if (state.status === "loading") {
    return (
      <div className="space-y-6">
        <div className="h-8 w-48 animate-pulse rounded bg-muted" />
        <div className="grid grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-lg border bg-muted/30" />
          ))}
        </div>
      </div>
    )
  }

  if (state.status === "error") {
    return (
      <div className="space-y-4">
        <Button asChild variant="ghost" size="sm">
          <Link href="/partners">
            <ArrowLeftIcon className="mr-1.5 size-4" />
            Back to Dashboard
          </Link>
        </Button>
        <p className="text-sm text-destructive">{state.message}</p>
      </div>
    )
  }

  const { partner, current, prior, ga4 } = state

  return (
    <div className="space-y-8">
      {/* Back nav */}
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/partners">
          <ArrowLeftIcon className="mr-1.5 size-4" />
          Back to Dashboard
        </Link>
      </Button>

      <PageHeader
        eyebrow="Ongoing / Partner Dashboard"
        title={partner.name}
        subtitle={
          <a
            href={
              partner.website.startsWith("http")
                ? partner.website
                : `https://${partner.website}`
            }
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-mono text-sm text-muted-foreground hover:text-foreground"
          >
            {partner.website.replace(/^https?:\/\//, "")}
            <ExternalLinkIcon className="size-3" />
          </a>
        }
      />

      {/* Partner meta */}
      <div className="flex flex-wrap gap-2 text-xs">
        {partner.services.split(/[,;]\s*/).slice(0, 6).map((s) => (
          <Badge key={s} variant="secondary">
            {s.trim()}
          </Badge>
        ))}
        {partner.unfilledContext && partner.unfilledContext.length > 0 && (
          <Badge
            variant="outline"
            className="border-amber-500/40 bg-amber-500/10 text-amber-700"
          >
            Incomplete Airtable context
          </Badge>
        )}
      </div>

      {/* GSC metrics */}
      {current && (
        <section className="space-y-3">
          <h2 className="font-sans text-xs font-extrabold uppercase tracking-[0.18em] text-muted-foreground">
            Last 28 Days (GSC)
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <MetricCard
              label="Clicks"
              value={fmt(current.clicks)}
              sub={fmtDelta(current.clicks, prior?.clicks ?? null) ?? undefined}
            />
            <MetricCard
              label="Impressions"
              value={fmt(current.impressions)}
              sub={fmtDelta(current.impressions, prior?.impressions ?? null) ?? undefined}
            />
            <MetricCard
              label="Avg Position"
              value={current.avgPosition !== null ? current.avgPosition.toFixed(1) : "—"}
              sub={fmtDelta(current.avgPosition, prior?.avgPosition ?? null) ?? undefined}
            />
            <MetricCard
              label="CTR"
              value={`${(current.avgCtr * 100).toFixed(1)}%`}
            />
          </div>
        </section>
      )}

      {!state.gscSiteUrl && (
        <p className="text-sm text-muted-foreground">
          No GSC property matched this partner&apos;s website. Check that the
          SEO Ops Google account has access to this site in Search Console.
        </p>
      )}

      {/* GA4 metrics */}
      {ga4 && (
        <section className="space-y-3">
          <h2 className="font-sans text-xs font-extrabold uppercase tracking-[0.18em] text-muted-foreground">
            Last 28 Days (GA4)
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <MetricCard label="Sessions" value={fmt(ga4.sessions)} />
            {ga4.conversionsConfigured ? (
              <MetricCard label="Conversions" value={fmt(ga4.conversions)} />
            ) : (
              <MetricCard label="Conversions" value="—" sub="not configured" />
            )}
          </div>
        </section>
      )}

      <Separator />

      {/* Scheduled task history */}
      <ScheduledTaskHistory partnerId={partner.id} />

      <Separator />

      {/* DataForSEO actions */}
      <DfseoActionsPanel partner={partner} />

      <Separator />

      {/* Report generation */}
      <PartnerReportSection partner={partner} />
    </div>
  )
}

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}
