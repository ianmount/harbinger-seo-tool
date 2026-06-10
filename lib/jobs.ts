import "server-only"
import { cookies } from "next/headers"
import { COOKIE_NAME, verifyToken } from "@/lib/auth"
import { env } from "@/lib/env"
import { getSupabase } from "@/lib/supabase"

/**
 * Background Jobs system.
 *
 * One row in `background_jobs` per long-running task (Audit, Comp Analysis,
 * Initial Strategy, Technical Crawl, Alt Tags). The HTTP route that starts a
 * job inserts a row, fires an Inngest event, and returns the row id. The
 * Inngest function reads the row, runs the matching task with the helpers
 * below, and finalizes the row to `completed` or `failed`.
 *
 * Session scoping: every row carries a `session_id` derived from the auth
 * cookie's `iat` (issued-at). Re-logging-in produces a new iat → old jobs
 * disappear from the user's tray without being deleted. Matches the
 * "session-only" requirement.
 */

export type JobKind =
  | "audit"
  | "comp_analysis"
  | "initial_strategy"
  | "technical_crawl"
  | "alt_tags"
  | "full_audit"
  | "keyword_research"
  | "gbp_heatmap"

export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"

/**
 * Thrown by task code when it observes the job has been cancelled. The
 * runner catches this and finalizes the row as `cancelled` (rather than
 * `failed`, so the email + UI can distinguish user-initiated stops from
 * actual failures).
 */
export class JobCancelledError extends Error {
  constructor(jobId: string) {
    super(`Job ${jobId} was cancelled`)
    this.name = "JobCancelledError"
  }
}

export interface JobProgress {
  stage?: string
  detail?: string
  percent?: number | null
}

export interface JobRow {
  id: string
  kind: JobKind
  status: JobStatus
  title: string
  input: unknown
  result: unknown | null
  error: string | null
  progress: JobProgress
  session_id: string
  result_path: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

const TABLE = "background_jobs"

// Human-readable labels used in the JobsTray and email subjects.
export const KIND_LABELS: Record<JobKind, string> = {
  audit: "Audit",
  comp_analysis: "Competitive Analysis",
  initial_strategy: "Initial Strategy",
  technical_crawl: "Technical Crawl",
  alt_tags: "Alt Tags",
  full_audit: "Full Audit",
  keyword_research: "Keyword Research",
  gbp_heatmap: "GBP Heatmap",
}

// ── Session id ─────────────────────────────────────────────────────────────

/**
 * Reserved session_id for jobs created by the scheduled-task dispatcher
 * (desktop Routine bot). These jobs aren't owned by any logged-in user, so
 * the per-session access check would always 404 them. `canAccessJob` lets
 * any authenticated session view them.
 */
export const ROUTINE_SESSION_ID = "routine"

/**
 * Whether the current session is allowed to read or cancel `job`. Allows
 * the owning session OR any authenticated session for routine/scheduled
 * jobs (which have no real owner). The proxy already gates these routes
 * for unauthenticated callers.
 */
export function canAccessJob(job: JobRow, sessionId: string): boolean {
  return job.session_id === sessionId || job.session_id === ROUTINE_SESSION_ID
}

/**
 * Derive a stable session id from the auth cookie. Returns the cookie's
 * `iat` as a string. Throws if the cookie is missing or invalid — but the
 * proxy in `proxy.ts` already gates the routes that call this, so a missing
 * cookie here means the proxy was bypassed and we should fail loudly.
 */
export async function deriveSessionId(): Promise<string> {
  const secret = env.APP_AUTH_SECRET
  if (!secret) {
    throw new Error("APP_AUTH_SECRET is not set; cannot derive session id")
  }
  const jar = await cookies()
  const token = jar.get(COOKIE_NAME)?.value
  const payload = verifyToken(secret, token)
  if (!payload) {
    throw new Error("No valid auth cookie; cannot derive session id")
  }
  return String(payload.iat)
}

// ── CRUD ────────────────────────────────────────────────────────────────────

interface CreateJobInput {
  kind: JobKind
  title: string
  input: unknown
  sessionId: string
  resultPath?: string
}

export async function createJob(args: CreateJobInput): Promise<JobRow> {
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      kind: args.kind,
      status: "queued",
      title: args.title,
      input: args.input ?? {},
      progress: {},
      session_id: args.sessionId,
      result_path: args.resultPath ?? null,
    })
    .select()
    .single()
  if (error || !data) {
    throw new Error(`createJob failed: ${error?.message ?? "no data returned"}`)
  }
  return data as JobRow
}

export async function getJob(id: string): Promise<JobRow | null> {
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("id", id)
    .maybeSingle()
  if (error) {
    throw new Error(`getJob failed: ${error.message}`)
  }
  return (data as JobRow | null) ?? null
}

export async function listJobsForSession(
  sessionId: string,
  limit = 25,
): Promise<JobRow[]> {
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(limit)
  if (error) {
    throw new Error(`listJobsForSession failed: ${error.message}`)
  }
  return (data as JobRow[] | null) ?? []
}

export async function markRunning(id: string): Promise<void> {
  const supabase = getSupabase()
  const { error } = await supabase
    .from(TABLE)
    .update({ status: "running" })
    .eq("id", id)
  if (error) throw new Error(`markRunning failed: ${error.message}`)
}

/**
 * Merge progress fields. Existing fields not in the patch are preserved, so
 * a task can update `detail` repeatedly without clobbering `stage`.
 */
export async function updateProgress(
  id: string,
  patch: JobProgress,
): Promise<void> {
  const current = await getJob(id)
  if (!current) return
  const next: JobProgress = { ...current.progress, ...patch }
  const supabase = getSupabase()
  const { error } = await supabase
    .from(TABLE)
    .update({ progress: next })
    .eq("id", id)
  if (error) throw new Error(`updateProgress failed: ${error.message}`)
}

export async function completeJob(
  id: string,
  result: unknown,
  resultPath?: string,
): Promise<void> {
  const supabase = getSupabase()
  const update: Record<string, unknown> = {
    status: "completed",
    result,
    completed_at: new Date().toISOString(),
  }
  if (resultPath) update.result_path = resultPath
  const { error } = await supabase.from(TABLE).update(update).eq("id", id)
  if (error) throw new Error(`completeJob failed: ${error.message}`)
}

export async function failJob(id: string, message: string): Promise<void> {
  const supabase = getSupabase()
  const { error } = await supabase
    .from(TABLE)
    .update({
      status: "failed",
      error: message,
      completed_at: new Date().toISOString(),
    })
    .eq("id", id)
  if (error) throw new Error(`failJob failed: ${error.message}`)
}

/**
 * Mark a job as cancelled. Idempotent — calling on a terminal job is a
 * no-op (the conditional update fails silently). Called from the cancel
 * route AND from the runner's catch path when the task throws
 * JobCancelledError.
 *
 * Cooperative: cancel() flips the row, then the running task observes
 * `isCancelRequested(id)` at its next progress checkpoint and throws
 * JobCancelledError. The runner finalizes via this same helper, which
 * fills in completed_at the second time.
 */
export async function cancelJob(id: string, reason?: string): Promise<void> {
  const supabase = getSupabase()
  const { error } = await supabase
    .from(TABLE)
    .update({
      status: "cancelled",
      error: reason ?? "Cancelled by user",
      completed_at: new Date().toISOString(),
    })
    .eq("id", id)
    // Don't overwrite already-terminal rows. completed/failed jobs stay as
    // they were; queued/running flip to cancelled.
    .in("status", ["queued", "running"])
  if (error) throw new Error(`cancelJob failed: ${error.message}`)
}

/**
 * Has someone requested cancellation while this task is running? Tasks
 * call this between expensive sub-steps (network requests, large
 * computations) and throw JobCancelledError when it returns true.
 *
 * Best-effort: a transient DB error returns false (let the task keep
 * running) rather than aborting on a hiccup.
 */
export async function isCancelRequested(id: string): Promise<boolean> {
  try {
    const job = await getJob(id)
    return job?.status === "cancelled"
  } catch {
    return false
  }
}

/**
 * Belt-and-suspenders for orphaned `running` rows.
 *
 * Vercel functions are killed at the 800s ceiling. The Inngest dispatcher's
 * onFailure handler is supposed to mark the row as failed when that
 * happens, but if onFailure also fails (rate limit, network blip), the row
 * stays "running" forever and the user has no path to recover except a
 * manual Cancel.
 *
 * This sweeper marks any `running`/`queued` job whose `updated_at` is
 * older than `staleAfterMs` as failed with a clear "stale" reason. It's
 * called opportunistically from the GET /api/jobs endpoint — the
 * worst-case latency is "user opens the Jobs tray, stale rows flip to
 * failed within one poll cycle."
 *
 * Threshold defaults to 18 minutes — comfortably beyond the 13.3-min
 * Vercel hard cap so legitimate-but-slow runs don't get falsely killed,
 * but tight enough that a stuck row doesn't sit around for days.
 */
export async function sweepStaleJobs(
  staleAfterMs = 18 * 60 * 1000,
): Promise<number> {
  const cutoff = new Date(Date.now() - staleAfterMs).toISOString()
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from(TABLE)
    .update({
      status: "failed",
      error:
        "Job did not finish within the function-runtime ceiling and was marked stale.",
      completed_at: new Date().toISOString(),
    })
    .in("status", ["queued", "running"])
    .lt("updated_at", cutoff)
    .select("id")
  if (error) {
    console.error("[sweepStaleJobs] failed:", error.message)
    return 0
  }
  return Array.isArray(data) ? data.length : 0
}
