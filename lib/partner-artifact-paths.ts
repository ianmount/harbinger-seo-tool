import type { PartnerArtifact } from "@/lib/types"

/**
 * Map a saved artifact back to its "full result" page if one exists.
 *
 * The three background-job-backed artifact kinds (technical_crawl,
 * audit, initial_strategy) all have purpose-built viewers elsewhere in
 * the app. When we can derive their key, link straight there instead of
 * landing the user on the generic artifact detail page.
 *
 * Returns null when there's no known viewer — caller falls back to the
 * generic `/partners/:id/artifacts/:artifactId` page.
 */
export function getArtifactExternalPath(
  artifact: PartnerArtifact,
): string | null {
  switch (artifact.kind) {
    case "technical_crawl": {
      // technical_crawl tasks write { crawlId, ... } at finalize time;
      // /scheduled-tasks/runs/[crawlId] reuses CrawlDetail.
      const crawlId =
        artifact.data &&
        typeof artifact.data === "object" &&
        "crawlId" in artifact.data &&
        typeof (artifact.data as Record<string, unknown>).crawlId === "string"
          ? ((artifact.data as Record<string, unknown>).crawlId as string)
          : null
      return crawlId ? `/scheduled-tasks/runs/${crawlId}` : null
    }
    case "audit": {
      // Full-audit task's resultPath is /audits/[jobId].
      return artifact.jobId ? `/audits/${artifact.jobId}` : null
    }
    case "strategy": {
      // The Initial-Strategy task writes its artifact with kind="strategy"
      // and a `jobId` referring to the onboarding/initial-strategy page.
      // Manually-saved strategy artifacts (no jobId) stay on the generic
      // detail page.
      return artifact.jobId
        ? `/onboarding/initial-strategy?job=${artifact.jobId}`
        : null
    }
    default:
      return null
  }
}

/** Human-readable label for a kind. Mirrored in components/partner-workspace/ArtifactsPanel. */
export const ARTIFACT_KIND_LABEL: Record<string, string> = {
  keyword_list: "Keyword list",
  faq_research: "FAQ research",
  strategy: "Strategy",
  content_brief: "Content brief",
  content_copy: "Content copy",
  backlink_prospects: "Backlink prospects",
  outreach_drafts: "Outreach drafts",
  report: "Report",
  technical_crawl: "Technical crawl",
  competitive_analysis: "Competitive analysis",
  audit: "Audit",
}
