"use client"

import { Suspense, useState } from "react"
import { useSearchParams } from "next/navigation"
import { PageHeader } from "@/components/PageHeader"
import { HistoryPanel } from "@/components/technical-crawls/HistoryPanel"
import { RunNowPanel } from "@/components/technical-crawls/RunNowPanel"
import { SchedulesPanel } from "@/components/technical-crawls/SchedulesPanel"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"

type View = "run" | "schedules" | "history"

function TechnicalCrawlsPageInner() {
  const searchParams = useSearchParams()
  const initialView: View =
    searchParams.get("view") === "history"
      ? "history"
      : searchParams.get("view") === "schedules"
        ? "schedules"
        : "run"
  const [view, setView] = useState<View>(initialView)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Tool / Technical Crawls"
        title="Technical Crawls"
        tail="— monthly site health, on demand."
        subtitle={
          <>
            Run a deep technical audit for any partner or one-off URL —{" "}
            <b className="font-sans font-extrabold not-italic text-foreground">
              DataForSEO
            </b>{" "}
            On-Page crawl plus mobile{" "}
            <b className="font-sans font-extrabold not-italic text-foreground">
              Lighthouse
            </b>{" "}
            on the homepage and a small sample. Schedule monthly runs for any
            partner, or kick off an ad-hoc check.
          </>
        }
      />

      <Tabs value={view} onValueChange={(v) => setView(v as View)}>
        <TabsList>
          <TabsTrigger value="run">Run now</TabsTrigger>
          <TabsTrigger value="schedules">Schedules</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="run" className="mt-6">
          <RunNowPanel />
        </TabsContent>

        <TabsContent value="schedules" className="mt-6">
          <SchedulesPanel />
        </TabsContent>

        <TabsContent value="history" className="mt-6">
          <HistoryPanel
            selectedRunId={selectedRunId}
            onSelectRun={setSelectedRunId}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}

export default function TechnicalCrawlsPage() {
  return (
    <Suspense fallback={null}>
      <TechnicalCrawlsPageInner />
    </Suspense>
  )
}
