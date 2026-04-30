-- Schema for the Technical Crawls tab.
--
-- Run this once against a fresh Supabase project (Dashboard → SQL Editor →
-- New query → paste → Run). Idempotent: every CREATE uses IF NOT EXISTS.
--
-- Tables:
--   crawl_runs           — one row per technical crawl (manual or routine).
--   crawl_subscriptions  — one row per partner enrolled in scheduled crawls.
--
-- The app accesses both tables exclusively via the service-role key from a
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

-- ── crawl_subscriptions ────────────────────────────────────────────────────

create table if not exists public.crawl_subscriptions (
  id              uuid primary key default gen_random_uuid(),
  partner_id      text not null unique,                       -- Airtable record id; one subscription per partner
  partner_name    text not null,
  frequency       text not null check (frequency in ('weekly', 'monthly')),
  -- 0=Sun..6=Sat for weekly. Null for monthly.
  day_of_week     smallint check (day_of_week is null or (day_of_week >= 0 and day_of_week <= 6)),
  -- 1..31 for monthly (clamped to month length at run time). Null for weekly.
  day_of_month    smallint check (day_of_month is null or (day_of_month >= 1 and day_of_month <= 31)),
  enabled         boolean not null default true,
  -- next_run_at drives the Routine's "what's due" query. Server bumps this
  -- after every successful crawl based on (frequency, day_*) using the
  -- America/New_York timezone for "day boundary" math. Stored UTC.
  next_run_at     timestamptz not null,
  last_run_at     timestamptz,
  last_crawl_id   uuid references public.crawl_runs(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- Sanity: weekly rows must have day_of_week, monthly rows must have day_of_month.
  constraint crawl_subscriptions_frequency_day_consistent
    check (
      (frequency = 'weekly'  and day_of_week is not null and day_of_month is null) or
      (frequency = 'monthly' and day_of_month is not null and day_of_week is null)
    )
);

create index if not exists crawl_subscriptions_due_idx
  on public.crawl_subscriptions (enabled, next_run_at);

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
    'alt_tags'
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
