"use client"

import { use, useEffect, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { ArrowLeftIcon, ExternalLinkIcon } from "lucide-react"
import { DfseoActionsPanel } from "@/components/partner-dashboard/DfseoActionsPanel"
import { PartnerPerformancePanel } from "@/components/partner-dashboard/PartnerPerformancePanel"
import { PartnerReportSection } from "@/components/partner-dashboard/PartnerReportSection"
import { ScheduledTaskHistory } from "@/components/partner-dashboard/ScheduledTaskHistory"
import { ArtifactsPanel } from "@/components/partner-workspace/ArtifactsPanel"
import { SettingsPanel } from "@/components/partner-workspace/SettingsPanel"
import { PageHeader } from "@/components/PageHeader"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { Partner, PartnerSnapshot } from "@/lib/types"

type PageState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "done"
      partner: Partner
      gscSiteUrl: string | null
      ga4PropertyId: string | null
    }

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

type TabValue = "overview" | "artifacts" | "settings"

function isTab(v: string | null): v is TabValue {
  return v === "overview" || v === "artifacts" || v === "settings"
}

export default function PartnerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  const router = useRouter()
  const searchParams = useSearchParams()
  const tabParam = searchParams.get("tab")
  const activeTab: TabValue = isTab(tabParam) ? tabParam : "overview"

  const [state, setState] = useState<PageState>({ status: "loading" })

  useEffect(() => {
    let cancelled = false
    async function loadPartner() {
      try {
        const partnerRes = await fetch(
          `/api/partners/${encodeURIComponent(id)}`,
        )
        const partnerBody = (await partnerRes.json()) as {
          partner?: Partner
          error?: string
        }
        if (!partnerRes.ok || !partnerBody.partner) {
          throw new Error(partnerBody.error ?? "Partner not found")
        }
        const partner = partnerBody.partner

        // Pull resolved GSC site + GA4 property from the snapshot endpoint.
        // 28-day window matches the dashboard cache so this is usually warm.
        const today = new Date()
        const endDate = iso(today)
        const startDate = iso(new Date(today.getTime() - 27 * 86_400_000))
        const snapRes = await fetch(
          `/api/partners/snapshot?startDate=${startDate}&endDate=${endDate}`,
          { cache: "no-store" },
        )
        let gscSiteUrl: string | null = partner.gscSiteUrl ?? null
        let ga4PropertyId: string | null = partner.ga4PropertyId ?? null
        if (snapRes.ok) {
          const snapBody = (await snapRes.json()) as {
            snapshots?: PartnerSnapshot[]
          }
          const snap = snapBody.snapshots?.find((s) => s.partner.id === id)
          if (snap) {
            gscSiteUrl = snap.gscSiteUrl ?? gscSiteUrl
            ga4PropertyId = snap.ga4PropertyId ?? ga4PropertyId
          }
        }

        if (cancelled) return
        setState({ status: "done", partner, gscSiteUrl, ga4PropertyId })
      } catch (err) {
        if (cancelled) return
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "Failed to load partner",
        })
      }
    }
    loadPartner()
    return () => {
      cancelled = true
    }
  }, [id])

  function handleTabChange(value: string) {
    const params = new URLSearchParams(searchParams.toString())
    if (value === "overview") params.delete("tab")
    else params.set("tab", value)
    const query = params.toString()
    router.replace(query ? `?${query}` : `/partners/${id}`, { scroll: false })
  }

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
            All Partners
          </Link>
        </Button>
        <p className="text-sm text-destructive">{state.message}</p>
      </div>
    )
  }

  const { partner, gscSiteUrl, ga4PropertyId } = state

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/partners">
          <ArrowLeftIcon className="mr-1.5 size-4" />
          All Partners
        </Link>
      </Button>

      <PageHeader
        eyebrow="Partners / Workspace"
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

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList variant="line" className="w-full justify-start gap-4 border-b border-border">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="artifacts">Artifacts</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-8 pt-6">
          <PartnerPerformancePanel
            gscSiteUrl={gscSiteUrl}
            ga4PropertyId={ga4PropertyId}
          />

          <Separator />

          <ScheduledTaskHistory partnerId={partner.id} />

          <Separator />

          <DfseoActionsPanel partner={partner} />

          <Separator />

          <PartnerReportSection partner={partner} />
        </TabsContent>

        <TabsContent value="artifacts" className="pt-6">
          <ArtifactsPanel partnerId={partner.id} />
        </TabsContent>

        <TabsContent value="settings" className="pt-6">
          <SettingsPanel
            partner={partner}
            onUpdated={(updated) =>
              setState({
                status: "done",
                partner: updated,
                gscSiteUrl,
                ga4PropertyId,
              })
            }
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
