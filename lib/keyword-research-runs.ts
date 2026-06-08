import "server-only"
import { getSupabase } from "@/lib/supabase"
import type {
  KeywordCandidate,
  KeywordDrop,
  KeywordResearchConfig,
  KeywordResearchLocation,
  KeywordResearchResult,
  KeywordResearchRun,
  KeywordResearchStatus,
  SeedProposalGroup,
} from "@/lib/types"

/**
 * Supabase access for the Keyword Research tab. Runs are session-scoped
 * exactly like background_jobs (session_id = auth cookie iat); see
 * lib/jobs.ts deriveSessionId(). No partner linkage — this is an ad-hoc
 * prospect-style flow.
 */

const RUNS = "keyword_research_runs"
const TASKS = "keyword_research_rank_tasks"

// ── Row shapes (hand-typed; columns are snake_case JSON-y) ───────────────────

interface RunRow {
  id: string
  session_id: string
  domain: string
  services: string[] | null
  status: KeywordResearchStatus
  config: KeywordResearchConfig
  locations: KeywordResearchLocation[]
  seeds: {
    proposal?: SeedProposalGroup[]
    prospect?: KeywordCandidate[]
    drops?: KeywordDrop[]
  } | null
  approved_seeds: string[] | null
  prospect: { candidates?: KeywordCandidate[]; drops?: KeywordDrop[] } | null
  approved_keywords: string[] | null
  result: KeywordResearchResult | null
  error: string | null
  job_id: string | null
  cost_usd: number | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

function rowToRun(row: RunRow): KeywordResearchRun {
  return {
    id: row.id,
    domain: row.domain,
    services: row.services ?? [],
    status: row.status,
    config: row.config,
    locations: row.locations ?? [],
    seedProposal: row.seeds?.proposal ?? null,
    approvedSeeds: row.approved_seeds ?? null,
    prospect: row.prospect?.candidates ?? null,
    drops: row.prospect?.drops ?? null,
    approvedKeywords: row.approved_keywords ?? null,
    result: row.result ?? null,
    error: row.error,
    jobId: row.job_id,
    costUsd: row.cost_usd,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }
}

// ── Run CRUD ─────────────────────────────────────────────────────────────────

export interface CreateRunInput {
  sessionId: string
  domain: string
  services: string[]
  config: KeywordResearchConfig
  locations: KeywordResearchLocation[]
  seedProposal: SeedProposalGroup[]
}

export async function createRun(input: CreateRunInput): Promise<KeywordResearchRun> {
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from(RUNS)
    .insert({
      session_id: input.sessionId,
      domain: input.domain,
      services: input.services,
      status: "seeds_review" satisfies KeywordResearchStatus,
      config: input.config,
      locations: input.locations,
      seeds: { proposal: input.seedProposal },
    })
    .select()
    .single()
  if (error || !data) {
    throw new Error(`createRun failed: ${error?.message ?? "no data"}`)
  }
  return rowToRun(data as RunRow)
}

export async function getRun(id: string): Promise<KeywordResearchRun | null> {
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from(RUNS)
    .select("*")
    .eq("id", id)
    .maybeSingle()
  if (error) throw new Error(`getRun failed: ${error.message}`)
  return data ? rowToRun(data as RunRow) : null
}

/** Fetch a run only if it belongs to the session; null otherwise. */
export async function getRunForSession(
  id: string,
  sessionId: string,
): Promise<KeywordResearchRun | null> {
  const run = await getRun(id)
  if (!run) return null
  // Re-read raw session_id via a targeted query to avoid leaking other
  // sessions' runs. getRun doesn't expose session_id, so check here.
  const supabase = getSupabase()
  const { data } = await supabase
    .from(RUNS)
    .select("session_id")
    .eq("id", id)
    .maybeSingle()
  if (!data || (data as { session_id: string }).session_id !== sessionId) {
    return null
  }
  return run
}

export async function listRunsForSession(
  sessionId: string,
  limit = 25,
): Promise<KeywordResearchRun[]> {
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from(RUNS)
    .select("*")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(limit)
  if (error) throw new Error(`listRunsForSession failed: ${error.message}`)
  return ((data as RunRow[] | null) ?? []).map(rowToRun)
}

/** Overwrite the seed proposal (used by the seed-regeneration flow). */
export async function setSeedProposal(
  id: string,
  proposal: SeedProposalGroup[],
): Promise<void> {
  await updateRunRaw(id, { seeds: { proposal } })
}

/** Persist the approved seeds + status transition into generating. */
export async function setApprovedSeeds(
  id: string,
  approvedSeeds: string[],
): Promise<void> {
  await updateRunRaw(id, {
    approved_seeds: approvedSeeds,
    status: "generating",
  })
}

/** Persist the curated prospect list + drops, move to keywords_review. */
export async function setProspect(
  id: string,
  candidates: KeywordCandidate[],
  drops: KeywordDrop[],
): Promise<void> {
  await updateRunRaw(id, {
    prospect: { candidates, drops },
    status: "keywords_review",
  })
}

/** Link the localize background job + record the user's pruned keyword set. */
export async function setLocalizing(
  id: string,
  approvedKeywords: string[],
  jobId: string,
): Promise<void> {
  await updateRunRaw(id, {
    approved_keywords: approvedKeywords,
    job_id: jobId,
    status: "localizing",
  })
}

export async function setStatus(
  id: string,
  status: KeywordResearchStatus,
  error?: string,
): Promise<void> {
  const patch: Record<string, unknown> = { status }
  if (error !== undefined) patch.error = error
  if (status === "completed" || status === "failed" || status === "cancelled") {
    patch.completed_at = new Date().toISOString()
  }
  await updateRunRaw(id, patch)
}

export async function completeRun(
  id: string,
  result: KeywordResearchResult,
): Promise<void> {
  await updateRunRaw(id, {
    status: "completed",
    result,
    cost_usd: result.costUsd,
    completed_at: new Date().toISOString(),
  })
}

async function updateRunRaw(
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const supabase = getSupabase()
  const { error } = await supabase.from(RUNS).update(patch).eq("id", id)
  if (error) throw new Error(`updateRun failed: ${error.message}`)
}

// ── Rank-task tracking (SERP queue) ──────────────────────────────────────────

export interface RankTaskRow {
  id: string
  run_id: string
  location_slug: string
  location_code: number
  keyword: string
  city_volume: number | null
  dfs_task_id: string | null
  status: "pending" | "done" | "failed"
  rank: number | null
  created_at: string
}

export interface NewRankTask {
  locationSlug: string
  locationCode: number
  keyword: string
  cityVolume: number | null
  dfsTaskId: string
}

export async function insertRankTasks(
  runId: string,
  tasks: NewRankTask[],
): Promise<void> {
  if (tasks.length === 0) return
  const supabase = getSupabase()
  const rows = tasks.map((t) => ({
    run_id: runId,
    location_slug: t.locationSlug,
    location_code: t.locationCode,
    keyword: t.keyword,
    city_volume: t.cityVolume,
    dfs_task_id: t.dfsTaskId,
    status: "pending" as const,
  }))
  // Chunk to keep the insert payload reasonable.
  const CHUNK = 500
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabase.from(TASKS).insert(rows.slice(i, i + CHUNK))
    if (error) throw new Error(`insertRankTasks failed: ${error.message}`)
  }
}

export async function getPendingRankTasks(runId: string): Promise<RankTaskRow[]> {
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from(TASKS)
    .select("*")
    .eq("run_id", runId)
    .eq("status", "pending")
  if (error) throw new Error(`getPendingRankTasks failed: ${error.message}`)
  return (data as RankTaskRow[] | null) ?? []
}

export async function getAllRankTasks(runId: string): Promise<RankTaskRow[]> {
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from(TASKS)
    .select("*")
    .eq("run_id", runId)
  if (error) throw new Error(`getAllRankTasks failed: ${error.message}`)
  return (data as RankTaskRow[] | null) ?? []
}

export async function markRankTaskDone(
  id: string,
  rank: number | null,
): Promise<void> {
  const supabase = getSupabase()
  const { error } = await supabase
    .from(TASKS)
    .update({ status: "done", rank })
    .eq("id", id)
  if (error) throw new Error(`markRankTaskDone failed: ${error.message}`)
}

export async function markRankTaskFailed(id: string): Promise<void> {
  const supabase = getSupabase()
  const { error } = await supabase
    .from(TASKS)
    .update({ status: "failed" })
    .eq("id", id)
  if (error) throw new Error(`markRankTaskFailed failed: ${error.message}`)
}
