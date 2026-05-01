/**
 * Shared client-side row shapes for the Scheduled Tasks tab. Mirrors what
 * the server returns from /api/scheduled-tasks/* — hand-typed, not derived
 * from Supabase types, so each list endpoint can pick its own column set.
 */

import type { AttentionSummary } from "@/lib/attention"

export type TaskKind = "technical_crawl" | "full_audit"
export type Frequency = "daily" | "weekly" | "monthly"
export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"

export interface TaskSchedule {
  id: string
  partner_id: string
  partner_name: string
  kind: TaskKind
  frequency: Frequency
  day_of_week: number | null
  day_of_month: number | null
  enabled: boolean
  next_run_at: string
  last_run_at: string | null
  last_job_id: string | null
  created_at: string
  updated_at: string
}

export interface AttentionItem {
  id: string
  kind: TaskKind
  status: JobStatus
  title: string
  attention_summary: AttentionSummary | null
  completed_at: string | null
  created_at: string
  result_path: string | null
}

export interface RecentRun {
  id: string
  kind: TaskKind
  status: JobStatus
  title: string
  result_path: string | null
  needs_attention: boolean
  attention_summary: AttentionSummary | null
  error: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
  input: { partnerId?: string; url?: string } | null
}
