"use client"

import { use } from "react"
import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import { CrawlDetail } from "@/components/technical-crawls/CrawlDetail"

/**
 * Per-technical-crawl run viewer. Reached from the Recent Runs table on
 * /scheduled-tasks and from completed-job result_path links. Reuses the
 * existing CrawlDetail component (which fetches /api/technical-crawls/runs/[id]
 * for the heavy JSONB payload).
 *
 * Full Audit runs use a separate viewer at /audits/[id], not this page.
 */
export default function ScheduledRunPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  return (
    <div className="space-y-6">
      <Button asChild size="sm" variant="ghost" className="gap-1">
        <Link href="/scheduled-tasks">
          <ArrowLeft className="h-4 w-4" />
          Back to scheduled tasks
        </Link>
      </Button>
      <CrawlDetail runId={id} />
    </div>
  )
}
