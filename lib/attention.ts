import "server-only"
import { getSupabase } from "@/lib/supabase"
import type { AssessmentAuditResult } from "@/lib/types"
import type {
  TechnicalCrawlLighthouse,
  TechnicalCrawlResult,
  TechnicalCrawlSummary,
} from "@/lib/technical-crawl"

/**
 * "Needs attention" computation for the Scheduled Tasks dashboard.
 *
 * Each task kind defines its own heuristics. The output goes into
 * `background_jobs.needs_attention` (boolean) and `attention_summary`
 * (jsonb). The dashboard reads only those two columns to render — it
 * doesn't re-parse the full result, so the issue copy here needs to
 * stand alone.
 *
 * Severity is the *highest* severity across the issues. Used by the UI
 * to sort + color the dashboard cards.
 */

export type AttentionSeverity = "high" | "medium" | "low"

export interface AttentionIssue {
  title: string
  detail?: string
  count?: number
  severity: AttentionSeverity
}

export interface AttentionSummary {
  severity: AttentionSeverity
  issues: AttentionIssue[]
}

const RANK: Record<AttentionSeverity, number> = { high: 3, medium: 2, low: 1 }

function rollupSeverity(issues: AttentionIssue[]): AttentionSeverity {
  let top: AttentionSeverity = "low"
  for (const issue of issues) {
    if (RANK[issue.severity] > RANK[top]) top = issue.severity
  }
  return top
}

// ── Technical crawl heuristics ─────────────────────────────────────────────

export function computeTechnicalCrawlAttention(
  result: TechnicalCrawlResult,
): AttentionSummary | null {
  const issues: AttentionIssue[] = []
  const s: TechnicalCrawlSummary = result.summary
  const total = s.totalPages || 0

  if (s.nonOkPages > 0) {
    issues.push({
      title: "Broken pages",
      detail: "URLs returned a non-2xx status during the crawl.",
      count: s.nonOkPages,
      severity: "high",
    })
  }

  if (s.spaShellPages > 0) {
    issues.push({
      title: "SPA-shell pages",
      detail:
        "Pages rendered an empty body to the crawler — content likely loads only after JS executes, which Google may miss.",
      count: s.spaShellPages,
      severity: "high",
    })
  }

  if (total > 0) {
    const missingTitlesPct = s.missingTitles / total
    if (missingTitlesPct > 0.1) {
      issues.push({
        title: "Missing <title> tags",
        detail: `${Math.round(missingTitlesPct * 100)}% of crawled pages have no <title>.`,
        count: s.missingTitles,
        severity: "medium",
      })
    }
    const missingDescPct = s.missingDescriptions / total
    if (missingDescPct > 0.1) {
      issues.push({
        title: "Missing meta descriptions",
        detail: `${Math.round(missingDescPct * 100)}% of crawled pages have no meta description.`,
        count: s.missingDescriptions,
        severity: "medium",
      })
    }
  }

  if (s.duplicateTitleGroups > 0) {
    issues.push({
      title: "Duplicate <title> tags",
      detail: "Multiple pages share the same exact title.",
      count: s.duplicateTitleGroups,
      severity: "medium",
    })
  }

  if (s.duplicateDescriptionGroups > 0) {
    issues.push({
      title: "Duplicate meta descriptions",
      detail: "Multiple pages share the same meta description.",
      count: s.duplicateDescriptionGroups,
      severity: "low",
    })
  }

  const lh: TechnicalCrawlLighthouse = result.lighthouse
  if (lh.averageMobileScore != null && lh.averageMobileScore < 50) {
    issues.push({
      title: "Poor mobile performance",
      detail: `Average mobile Lighthouse score is ${lh.averageMobileScore}.`,
      severity: "medium",
    })
  }

  if (s.imageAltCoveragePercent < 70) {
    issues.push({
      title: "Image alt coverage low",
      detail: `${s.imageAltCoveragePercent}% of images have alt text.`,
      severity: "low",
    })
  }

  if (s.sitemapSize === 0) {
    issues.push({
      title: "Sitemap missing or empty",
      detail: "No URLs were discovered via sitemap.xml.",
      severity: "medium",
    })
  }

  if (issues.length === 0) return null
  return { severity: rollupSeverity(issues), issues }
}

// ── Full audit heuristics ──────────────────────────────────────────────────

export function computeFullAuditAttention(
  result: AssessmentAuditResult,
): AttentionSummary | null {
  const issues: AttentionIssue[] = []
  const cs = result.crawlSummary

  if (cs) {
    const total = cs.pagesAnalyzed || 0
    if (cs.spaShellPages > 0) {
      issues.push({
        title: "SPA-shell pages",
        detail:
          "Pages rendered an empty body to the crawler — content likely loads only after JS, which Google may miss.",
        count: cs.spaShellPages,
        severity: "high",
      })
    }
    if (total > 0) {
      const missingTitlesPct = cs.missingTitles / total
      if (missingTitlesPct > 0.1) {
        issues.push({
          title: "Missing <title> tags",
          detail: `${Math.round(missingTitlesPct * 100)}% of crawled pages have no <title>.`,
          count: cs.missingTitles,
          severity: "medium",
        })
      }
      const missingDescPct = cs.missingDescriptions / total
      if (missingDescPct > 0.1) {
        issues.push({
          title: "Missing meta descriptions",
          detail: `${Math.round(missingDescPct * 100)}% of crawled pages have no meta description.`,
          count: cs.missingDescriptions,
          severity: "medium",
        })
      }
    }
    if (cs.duplicateTitles > 0) {
      issues.push({
        title: "Duplicate <title> tags",
        count: cs.duplicateTitles,
        severity: "medium",
      })
    }
  }

  // Cannibalization clusters surfaced by the audit pipeline are worth a
  // human's attention even at low counts — they always indicate a fixable
  // issue the SEO engineer should review.
  const clusterCount = result.cannibalization?.length ?? 0
  if (clusterCount > 0) {
    issues.push({
      title: "Keyword cannibalization clusters",
      detail: "Multiple pages competing for the same query.",
      count: clusterCount,
      severity: clusterCount >= 5 ? "medium" : "low",
    })
  }

  // Surface pipeline warnings (GSC denied, GA4 not granted, etc.) as a
  // single low-severity reminder — the SEO engineer often needs to act
  // on these (request access, etc.) but they're not failures.
  if (result.warnings && result.warnings.length > 0) {
    issues.push({
      title: "Audit pipeline warnings",
      detail:
        "One or more data sources were unavailable. See the audit report for details.",
      count: result.warnings.length,
      severity: "low",
    })
  }

  if (issues.length === 0) return null
  return { severity: rollupSeverity(issues), issues }
}

// ── Persistence ────────────────────────────────────────────────────────────

/**
 * Write the attention flag + summary onto the background_jobs row. Best-
 * effort: a transient DB error logs and returns rather than failing the
 * task (the run itself is already complete and the user has results).
 */
export async function markJobAttention(
  jobId: string,
  summary: AttentionSummary | null,
): Promise<void> {
  try {
    const supabase = getSupabase()
    await supabase
      .from("background_jobs")
      .update({
        needs_attention: summary != null,
        attention_summary: summary,
      })
      .eq("id", jobId)
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown"
    console.error(`[attention] markJobAttention failed for ${jobId}:`, msg)
  }
}
