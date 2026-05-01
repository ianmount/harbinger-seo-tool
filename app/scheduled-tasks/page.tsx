import { PageHeader } from "@/components/PageHeader"
import { AttentionDashboard } from "@/components/scheduled-tasks/AttentionDashboard"
import { RecentRuns } from "@/components/scheduled-tasks/RecentRuns"
import { SchedulePipeline } from "@/components/scheduled-tasks/SchedulePipeline"

/**
 * Scheduled Tasks tab. Replaces the old Technical Crawls tab and wraps it
 * inside a broader pipeline that handles both technical crawls and full
 * audits. Three sections, top to bottom:
 *
 *   1. Needs Attention — recent runs whose results flagged issues a
 *      human should review (broken pages, high-severity findings, etc.).
 *   2. Pipeline — the schedule list itself. Add / pause / delete / run-now.
 *   3. Recent Runs — last 50 runs across both kinds with attention badges
 *      and status, so the user can spot trouble at a glance.
 *
 * Schedules are fired by the desktop Routine bot via
 * POST /api/scheduled-tasks/run. UI changes here don't affect cadence.
 */
export default function ScheduledTasksPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Tool / Scheduled Tasks"
        title="Scheduled Tasks"
        tail="— pipeline, attention, history."
        subtitle={
          <>
            Schedule recurring{" "}
            <b className="font-sans font-extrabold not-italic text-foreground">
              technical crawls
            </b>{" "}
            and{" "}
            <b className="font-sans font-extrabold not-italic text-foreground">
              full audits
            </b>{" "}
            for any partner. Runs flagged with issues surface here at the top
            so nothing important falls through the cracks.
          </>
        }
      />

      <AttentionDashboard />
      <SchedulePipeline />
      <RecentRuns />
    </div>
  )
}
