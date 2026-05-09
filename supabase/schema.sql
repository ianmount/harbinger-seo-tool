-- Schema for the Scheduled Tasks tab (and supporting tables).
--
-- Run this once against a fresh Supabase project (Dashboard → SQL Editor →
-- New query → paste → Run). Idempotent: every CREATE uses IF NOT EXISTS.
--
-- Tables:
--   crawl_runs           — one row per technical crawl run (manual, ad-hoc,
--                          or fired by a scheduled task).
--   task_schedules       — unified schedule pipeline. One row per
--                          (partner, task kind) pair. Replaces the older
--                          per-partner-only crawl_subscriptions table.
--   background_jobs      — one row per long-running task (crawls, audits,
--                          comp analysis, etc.) fired through Inngest.
--
-- The app accesses these tables exclusively via the service-role key from a
-- Next.js server route, so RLS stays disabled. The whole app already sits
-- behind APP_PASSWORD or a bearer token (see proxy.ts).

create extension if not exists "pgcrypto";

-- ── crawl_runs ──────────────────────────────────────────────────────────────

create table if not exists public.crawl_runs (
  id                uuid primary key default gen_random_uuid(),
  partner_id        text,                                      -- Airtable record id; null for ad-hoc URL runs
  partner_name      text,                                      -- denormalized for fast list rendering
  domain            text not null,
  source            text not null check (source in ('manual', 'routine')),
  status            text not null check (status in ('running', 'done', 'failed')),
  started_at        timestamptz not null default now(),
  finished_at       timestamptz,
  duration_seconds  integer,
  cost_usd          numeric(10, 4),
  -- DataForSEO On-Page summary blob (lightly trimmed). Drives the dashboard cards.
  summary           jsonb,
  -- Mobile Lighthouse aggregates + per-URL scores for the sample set.
  lighthouse        jsonb,
  -- Output of buildSchemaCoverageMatrix() over the JSON-LD samples.
  schema_coverage   jsonb,
  -- Indexability rollup: counts of non-indexable pages, redirect chains, etc.
  indexability      jsonb,
  -- Sample pages with their issues (capped — we only persist the sample slice).
  sample_pages      jsonb,
  -- Per-issue URL lists (each capped at 200): missingTitles, missingDescriptions,
  -- missingCanonicals, duplicateTitles, duplicateDescriptions, thinContent,
  -- spaShell, nonOk, plus a `truncated` map flagging which lists hit the cap.
  -- Drives the dashboard's clickable summary tiles.
  issue_pages       jsonb,
  -- Non-fatal errors collected during the run (e.g. a single PSI URL failed).
  errors            jsonb
);

create index if not exists crawl_runs_partner_started_idx
  on public.crawl_runs (partner_id, started_at desc);

create index if not exists crawl_runs_started_idx
  on public.crawl_runs (started_at desc);

-- ── task_schedules ─────────────────────────────────────────────────────────
--
-- Unified schedule pipeline for the Scheduled Tasks tab. One row per
-- (partner_id, kind) pair — a partner can have one technical crawl AND one
-- full audit on different cadences, but not two crawls. The desktop Routine
-- bot polls this table for rows where enabled AND next_run_at <= now() and
-- enqueues a matching background job for each.
--
-- Replaces the older crawl_subscriptions table; see the 2026-05-01 migration
-- block at the bottom of this file for the one-time data move.

create table if not exists public.task_schedules (
  id              uuid primary key default gen_random_uuid(),
  partner_id      text not null,                              -- Airtable record id
  partner_name    text not null,
  kind            text not null check (kind in ('technical_crawl', 'full_audit')),
  frequency       text not null check (frequency in ('daily', 'weekly', 'monthly')),
  -- 0=Sun..6=Sat for weekly. Null for daily/monthly.
  day_of_week     smallint check (day_of_week is null or (day_of_week >= 0 and day_of_week <= 6)),
  -- 1..31 for monthly (clamped to month length at run time). Null for daily/weekly.
  day_of_month    smallint check (day_of_month is null or (day_of_month >= 1 and day_of_month <= 31)),
  enabled         boolean not null default true,
  -- next_run_at drives the Routine's "what's due" query. Server bumps this
  -- after every successful run based on (frequency, day_*). Stored UTC.
  next_run_at     timestamptz not null,
  last_run_at     timestamptz,
  -- Last background_jobs row id this schedule produced. Drives "View runs"
  -- shortcuts in the UI.
  last_job_id     uuid references public.background_jobs(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- One schedule per (partner, kind) pair.
  constraint task_schedules_partner_kind_unique unique (partner_id, kind),
  -- Sanity:
  --   daily   → both day_of_* null
  --   weekly  → day_of_week set, day_of_month null
  --   monthly → day_of_month set, day_of_week null
  constraint task_schedules_frequency_day_consistent
    check (
      (frequency = 'daily'   and day_of_week is null     and day_of_month is null)    or
      (frequency = 'weekly'  and day_of_week is not null and day_of_month is null)    or
      (frequency = 'monthly' and day_of_month is not null and day_of_week is null)
    )
);

create index if not exists task_schedules_due_idx
  on public.task_schedules (enabled, next_run_at);

create index if not exists task_schedules_kind_idx
  on public.task_schedules (kind, enabled);

-- ── background_jobs ────────────────────────────────────────────────────────
--
-- One row per long-running task started from the UI (Audit, Comp Analysis,
-- Initial Strategy, Technical Crawl, Alt Tags). The HTTP route that starts a
-- job inserts a row, fires an Inngest event, and returns the row id. The
-- Inngest function flips status -> running, writes progress updates as it
-- works, and finally writes result + completed (or error + failed).
--
-- Realtime is enabled on this table so the client can subscribe to its row
-- and render live progress without polling. session_id scopes the user's
-- "Jobs" tray: it's the iat (issued-at) timestamp of the auth cookie, so a
-- new login produces a new session_id and old jobs drop off the list.

create table if not exists public.background_jobs (
  id                uuid primary key default gen_random_uuid(),
  kind              text not null check (kind in (
    'audit',
    'comp_analysis',
    'initial_strategy',
    'technical_crawl',
    'alt_tags',
    'full_audit',
    'keyword_research'
  )),
  status            text not null check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  title             text not null,
  -- Free-form params blob; shape is task-specific. Validated by the task
  -- implementation, not by the DB.
  input             jsonb not null default '{}'::jsonb,
  -- Final output. Small results inline; large results store {blobUrl: ...}
  -- and the actual payload lives in Vercel Blob.
  result            jsonb,
  error             text,
  -- { stage: text, detail: text, percent: number | null }
  progress          jsonb not null default '{}'::jsonb,
  -- Auth cookie iat as a string. See lib/jobs.ts deriveSessionId().
  session_id        text not null,
  -- Where to render results. Used by the Jobs tray's "View" link.
  result_path       text,
  -- Set by the task at finalize-time when the run produced findings worth
  -- a human's attention (broken pages, high-severity audit findings, etc.).
  -- Drives the "Needs Attention" dashboard on /scheduled-tasks. Heuristics
  -- live in lib/attention/<kind>.ts.
  needs_attention   boolean not null default false,
  -- Human-readable summary of what flagged the row, used to render the
  -- attention dashboard cards without re-parsing the full result.
  -- Shape: { severity: 'high'|'medium'|'low', issues: [{title, detail?, count?}] }
  attention_summary jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  completed_at      timestamptz
);

create index if not exists background_jobs_session_idx
  on public.background_jobs (session_id, created_at desc);

create index if not exists background_jobs_status_idx
  on public.background_jobs (status, updated_at desc);

-- Bump updated_at on every UPDATE. The job runner relies on this for the
-- stale-job heuristic in the jobs list endpoint.
create or replace function public.background_jobs_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists background_jobs_updated_at on public.background_jobs;
create trigger background_jobs_updated_at
  before update on public.background_jobs
  for each row execute function public.background_jobs_set_updated_at();

-- Realtime publication. Idempotent-ish: ALTER PUBLICATION fails if the table
-- is already a member, so we wrap it in a DO block that swallows the
-- duplicate_object error.
do $$
begin
  alter publication supabase_realtime add table public.background_jobs;
exception
  when duplicate_object then null;
  when undefined_object then null;  -- publication doesn't exist on self-hosted
end;
$$;

-- ── Migrations (idempotent — safe to re-run on existing projects) ──────────
--
-- 2026-04-29: add issue_pages column to crawl_runs. Previous rows carried
-- only summary counts, not the underlying URL lists; this column persists
-- the full per-issue URL lists (capped at 200 per category) so the
-- dashboard's clickable summary tiles can reveal what's behind each count.

alter table public.crawl_runs
  add column if not exists issue_pages jsonb;

-- 2026-05-01: add 'cancelled' to background_jobs.status enum. Without this
-- migration, calling /api/jobs/<id>/cancel against a project that ran the
-- earlier schema would fail the CHECK constraint. Drops and re-adds the
-- check; safe to re-run.

alter table public.background_jobs
  drop constraint if exists background_jobs_status_check;
alter table public.background_jobs
  add constraint background_jobs_status_check
  check (status in ('queued', 'running', 'completed', 'failed', 'cancelled'));

-- 2026-05-01: add 'full_audit' to background_jobs.kind enum. The Scheduled
-- Tasks tab introduces a second schedulable task kind that wraps the
-- existing audit pipeline. Existing projects need this constraint widened
-- before /api/jobs/start will accept the new kind.

alter table public.background_jobs
  drop constraint if exists background_jobs_kind_check;
alter table public.background_jobs
  add constraint background_jobs_kind_check
  check (kind in (
    'audit',
    'comp_analysis',
    'initial_strategy',
    'technical_crawl',
    'alt_tags',
    'full_audit'
  ));

-- 2026-05-01: needs_attention + attention_summary columns on background_jobs.
-- Drives the "Needs Attention" dashboard on the new Scheduled Tasks page.
-- Existing rows default to false / null and never get back-filled — this
-- is a forward-only signal computed by the task at finalize-time.

alter table public.background_jobs
  add column if not exists needs_attention boolean not null default false;

alter table public.background_jobs
  add column if not exists attention_summary jsonb;

create index if not exists background_jobs_attention_idx
  on public.background_jobs (needs_attention, completed_at desc)
  where needs_attention = true;

-- 2026-05-01: migrate crawl_subscriptions → task_schedules.
--
-- The new task_schedules table is a generalization of the old
-- crawl_subscriptions table that supports multiple task kinds per partner
-- and adds 'daily' as a frequency option. This block copies any existing
-- crawl_subscriptions rows over with kind='technical_crawl' and then drops
-- the old table.
--
-- Idempotent: the INSERT uses ON CONFLICT DO NOTHING so re-running this
-- file after the migration has already executed is a no-op. The DROP is
-- guarded by IF EXISTS for the same reason.

do $$
begin
  if to_regclass('public.crawl_subscriptions') is not null then
    insert into public.task_schedules (
      partner_id, partner_name, kind, frequency,
      day_of_week, day_of_month, enabled,
      next_run_at, last_run_at, created_at, updated_at
    )
    select
      partner_id, partner_name, 'technical_crawl', frequency,
      day_of_week, day_of_month, enabled,
      next_run_at, last_run_at, created_at, updated_at
    from public.crawl_subscriptions
    on conflict (partner_id, kind) do nothing;
  end if;
end;
$$;

drop table if exists public.crawl_subscriptions;
