/**
 * Crawl row shapes for the CrawlDetail component. The schedule pipeline
 * has moved to /scheduled-tasks; this file is now scoped to the per-run
 * detail viewer at /scheduled-tasks/runs/[id], which still consumes the
 * /api/technical-crawls/runs/[id] endpoint for the heavy JSONB payload.
 */

import type {
  TechnicalCrawlIndexability,
  TechnicalCrawlLighthouse,
  TechnicalCrawlSummary,
  TechnicalIssuePages,
  TechnicalSamplePage,
} from "@/lib/technical-crawl"
import type { SchemaCoverageMatrix } from "@/lib/types"

export type CrawlSource = "manual" | "routine"
export type CrawlStatus = "running" | "done" | "failed"

/** Shallow row returned by /api/technical-crawls/list. */
export interface CrawlRunListItem {
  id: string
  partner_id: string | null
  partner_name: string | null
  domain: string
  source: CrawlSource
  status: CrawlStatus
  started_at: string
  finished_at: string | null
  duration_seconds: number | null
  cost_usd: number | null
}

/** Full crawl row returned by /api/technical-crawls/runs/[id]. */
export interface CrawlRunFull extends CrawlRunListItem {
  summary: TechnicalCrawlSummary | null
  lighthouse: TechnicalCrawlLighthouse | null
  schema_coverage: SchemaCoverageMatrix | null
  indexability: TechnicalCrawlIndexability | null
  sample_pages: TechnicalSamplePage[] | null
  issue_pages: TechnicalIssuePages | null
  errors: string[] | null
}
