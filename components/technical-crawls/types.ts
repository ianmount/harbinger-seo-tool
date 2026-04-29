/**
 * Shared client-side row shapes for the Technical Crawls tab.
 *
 * These are intentionally hand-typed (not derived from Supabase types) and
 * mirror what the API returns. The server-side engine types live in
 * `lib/technical-crawl.ts` — those are the source of truth for the JSONB
 * column contents; this file just describes the row envelope.
 */

import type {
  TechnicalCrawlIndexability,
  TechnicalCrawlLighthouse,
  TechnicalCrawlSummary,
  TechnicalSamplePage,
} from "@/lib/technical-crawl"
import type { SchemaCoverageMatrix } from "@/lib/types"

export type CrawlSource = "manual" | "routine"
export type CrawlStatus = "running" | "done" | "failed"
export type Frequency = "weekly" | "monthly"

/** Shallow row returned by /list — heavy JSONB columns omitted. */
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

/** Full crawl row returned by /runs/[id]. */
export interface CrawlRunFull extends CrawlRunListItem {
  summary: TechnicalCrawlSummary | null
  lighthouse: TechnicalCrawlLighthouse | null
  schema_coverage: SchemaCoverageMatrix | null
  indexability: TechnicalCrawlIndexability | null
  sample_pages: TechnicalSamplePage[] | null
  errors: string[] | null
}

export interface Subscription {
  id: string
  partner_id: string
  partner_name: string
  frequency: Frequency
  day_of_week: number | null
  day_of_month: number | null
  enabled: boolean
  next_run_at: string
  last_run_at: string | null
  last_crawl_id: string | null
  created_at: string
  updated_at: string
}
