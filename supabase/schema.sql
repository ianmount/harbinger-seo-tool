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
  -- `kind` is a free-form text column. Each task implementation lives in
  -- lib/tasks/<kind>.ts and is registered in the TASKS map in
  -- lib/inngest/functions.ts. The `JobKind` TypeScript union + the
  -- z.enum(KINDS) in app/api/jobs/start enforce valid kinds before any
  -- insert reaches the DB. We deliberately do NOT enforce a check
  -- constraint here — adding a new kind would otherwise require a
  -- coordinated DB migration on every deploy, and there's no harm in
  -- an unknown-kind row beyond the dispatcher failing it with a clear
  -- "No task implementation registered" message.
  kind              text not null,
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

-- 2026-05-12: drop background_jobs.kind check constraint. The TypeScript
-- JobKind union + z.enum(KINDS) at /api/jobs/start already enforce valid
-- kinds before the insert reaches Postgres; the dispatcher rejects
-- unmapped kinds with a clear "No task implementation registered" error.
-- Keeping the DB check meant every new kind required a coordinated
-- migration — too brittle. Dropping idempotently; safe to re-run.

alter table public.background_jobs
  drop constraint if exists background_jobs_kind_check;

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

-- ── partners ───────────────────────────────────────────────────────────────
--
-- Source of truth for the tool's partner records. Replaces the
-- previous Airtable-based read path; Airtable is no longer consulted at
-- runtime. The one-shot migration script
-- (scripts/migrate-airtable-partners.ts) seeds this table from Airtable
-- the first time and preserves the original Airtable record id in
-- `airtable_id` so the migration block lower in this file can rewrite
-- partner_id columns in background_jobs / crawl_runs / task_schedules.
--
-- gsc_account / ga4_account record which Google identity owns this
-- partner's integrations (the same two-account split as
-- GOOGLE_REFRESH_TOKEN_PARTNERS vs _ASSESSMENTS). gsc_site_url and
-- ga4_property_id are explicit overrides — when null, the existing
-- auto-detect helpers in lib/gsc-site-match.ts / lib/ga4-site-match.ts
-- still run.

create table if not exists public.partners (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  website             text not null,
  services            text not null default '',
  service_areas       text not null default '',
  partner_goals       text,
  target_audience     text,
  content_marketing   text,
  industry_knowledge  text,
  -- Explicit overrides for the two Google APIs. NULL means "auto-detect".
  gsc_site_url        text,
  gsc_account         text check (gsc_account in ('partners', 'assessments')),
  ga4_property_id     text,
  ga4_account         text check (ga4_account in ('partners', 'assessments')),
  -- Migration-only: original Airtable record id, preserved so existing
  -- rows in background_jobs / crawl_runs / task_schedules can be rewritten
  -- to the new UUID. NULL for partners onboarded via the tool itself.
  airtable_id         text unique,
  -- Free-form flag list (e.g. "services" if the Services field still
  -- holds the Airtable template boilerplate). Mirrors the Partner type's
  -- `unfilledContext` field; nullable.
  unfilled_context    text[],
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists partners_name_idx on public.partners (lower(name));
create index if not exists partners_website_idx on public.partners (lower(website));

create or replace function public.partners_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists partners_updated_at on public.partners;
create trigger partners_updated_at
  before update on public.partners
  for each row execute function public.partners_set_updated_at();

-- ── partner_artifacts ──────────────────────────────────────────────────────
--
-- Polymorphic "folder" for each partner. Every tool output that the user
-- saves to a partner lives here. `kind` is a free-form text column —
-- the TypeScript PartnerArtifactKind union in lib/types.ts enforces
-- valid kinds at write time. New kinds don't require a migration.
--
-- `data` is the canonical JSON payload (small) and `blob_url` points at
-- Vercel Blob for large payloads (PDF reports, full crawl exports).
-- `created_by_session` mirrors background_jobs.session_id semantics so
-- the UI can show "you saved this" vs "another session saved this".

create table if not exists public.partner_artifacts (
  id                  uuid primary key default gen_random_uuid(),
  partner_id          uuid not null references public.partners(id) on delete cascade,
  kind                text not null,
  title               text not null,
  data                jsonb not null default '{}'::jsonb,
  blob_url            text,
  -- Optional pointer to the background_jobs row that produced this
  -- artifact (audits, crawls, etc.). NULL for synchronously-saved
  -- outputs like a keyword list the user clicked "Save".
  job_id              uuid references public.background_jobs(id) on delete set null,
  created_by_session  text,
  created_at          timestamptz not null default now()
);

create index if not exists partner_artifacts_partner_kind_idx
  on public.partner_artifacts (partner_id, kind, created_at desc);

create index if not exists partner_artifacts_kind_idx
  on public.partner_artifacts (kind, created_at desc);

-- ── 2026-05-22: rewrite partner_id columns from Airtable id → uuid ────────
--
-- Existing rows in background_jobs, crawl_runs, and task_schedules were
-- written when partners lived in Airtable, so their `partner_id text`
-- columns hold Airtable record ids like "recXXXXXXXXX". After the
-- migration script has populated `partners.airtable_id`, this block
-- rewrites every such row to the new Supabase UUID.
--
-- Idempotent on three fronts:
--   1) Rows already holding a UUID (already migrated) don't match the
--      `recXXXX` substring filter, so they're left alone.
--   2) Rows whose Airtable id has no corresponding partners row (deleted
--      Airtable record) are left untouched — they'll surface as "Unknown
--      partner" in the UI rather than getting orphaned.
--   3) Re-running after the migration finds no `rec`-prefixed ids to
--      rewrite, so it's a no-op.

do $$
begin
  -- background_jobs.partner_id (denormalized in `input` jsonb, not a column)
  -- and the snapshot route both look at jobs by airtable id elsewhere — we
  -- don't touch the jsonb input blob here. Only top-level partner_id
  -- columns get rewritten.

  if to_regclass('public.background_jobs') is not null then
    -- background_jobs doesn't have a top-level partner_id column today;
    -- partner is referenced inside input jsonb. Tasks read partner via
    -- lib/partners.getPartner(uuid) after the input parser normalizes.
    -- No-op here.
    null;
  end if;

  update public.crawl_runs cr
  set partner_id = p.id::text
  from public.partners p
  where cr.partner_id is not null
    and cr.partner_id like 'rec%'
    and p.airtable_id = cr.partner_id;

  update public.task_schedules ts
  set partner_id = p.id::text
  from public.partners p
  where ts.partner_id like 'rec%'
    and p.airtable_id = ts.partner_id;
end;
$$;

-- 2026-05-22 (later that day): multi-property support for partners.
--
-- The original schema gave each partner ONE gsc_site_url + ONE
-- ga4_property_id. In practice partners can own multiple GSC sites
-- (apex + www variants, sc-domain entries, regional subdomains) and
-- multiple GA4 properties (one per brand/sub-brand), and the onboarding
-- form needs to capture all of them.
--
-- Schema change: add jsonb array columns alongside the existing scalars.
-- Each entry is `{ siteUrl | propertyId, account }`. The scalar columns
-- stay around and hold the FIRST entry of the array — that preserves
-- ~8 existing call sites that read partner.gscSiteUrl / .ga4PropertyId
-- as a single value. New code can read the full list off the array
-- columns. Writers (lib/partners.ts) keep both in sync.
--
-- Idempotent: both ALTER and the backfill UPDATE are no-ops on re-run.

alter table public.partners
  add column if not exists gsc_sites jsonb;

alter table public.partners
  add column if not exists ga4_properties jsonb;

-- Backfill arrays from the legacy scalar columns wherever the array is
-- null and the scalar is set. Only runs once per row.

update public.partners
set gsc_sites = jsonb_build_array(
  jsonb_build_object('siteUrl', gsc_site_url, 'account', gsc_account)
)
where gsc_sites is null
  and gsc_site_url is not null
  and gsc_account is not null;

update public.partners
set ga4_properties = jsonb_build_array(
  jsonb_build_object('propertyId', ga4_property_id, 'account', ga4_account)
)
where ga4_properties is null
  and ga4_property_id is not null
  and ga4_account is not null;

-- ── keyword_research_runs ────────────────────────────────────────────────────
--
-- 2026-06-08: city-level, per-seed keyword research (the "Keyword Research"
-- tab). Ad-hoc (no partner linkage) and session-scoped exactly like
-- background_jobs.session_id (auth cookie iat). One row per research run.
--
-- The run is a small state machine with two human-in-the-loop checkpoints:
--
--   seeds_review  → Claude proposed seeds; user edits/approves them
--   generating    → candidates being pulled + curated (synchronous route)
--   keywords_review → curated prospect list shown; user prunes + approves
--   localizing    → the paid background job runs (city volume + SERP queue)
--   completed | failed | cancelled
--
-- Big-ish JSON lives in columns:
--   seeds      — [{ service, seeds: [{ seed, nationalVolume }] }] proposal,
--                plus the user's approved list once confirmed.
--   prospect   — curated candidate list awaiting (or after) manual prune.
--   config     — { depth, targetPlanSize, market:{cities,states,extraAllow},
--                  competitors:[], disableCategories:[] }.
--   locations  — [{ slug, label, dfs, locationCode }] resolved up front.
--   result     — { locations: { <slug>: { rows: [...], droppedNoVolume,
--                  rankUnresolved } } } once the localize job finishes.
--
-- The localize phase is driven by a background_jobs row (kind
-- 'keyword_research'); `job_id` links to it. SERP queue task ids are tracked
-- in keyword_research_rank_tasks so polling survives instance recycles.

create table if not exists public.keyword_research_runs (
  id              uuid primary key default gen_random_uuid(),
  session_id      text not null,
  domain          text not null,
  services        text[] not null default '{}',
  status          text not null check (status in (
                     'seeds_review', 'generating', 'keywords_review',
                     'localizing', 'completed', 'failed', 'cancelled')),
  config          jsonb not null default '{}'::jsonb,
  locations       jsonb not null default '[]'::jsonb,
  seeds           jsonb,
  approved_seeds  text[],
  prospect        jsonb,
  approved_keywords text[],
  result          jsonb,
  error           text,
  -- The background_jobs row that runs the localize phase. Null until the
  -- user approves the curated list.
  job_id          uuid references public.background_jobs(id) on delete set null,
  cost_usd        numeric(10, 4),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  completed_at    timestamptz
);

create index if not exists keyword_research_runs_session_idx
  on public.keyword_research_runs (session_id, created_at desc);

create index if not exists keyword_research_runs_status_idx
  on public.keyword_research_runs (status, updated_at desc);

create or replace function public.keyword_research_runs_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists keyword_research_runs_updated_at on public.keyword_research_runs;
create trigger keyword_research_runs_updated_at
  before update on public.keyword_research_runs
  for each row execute function public.keyword_research_runs_set_updated_at();

-- ── keyword_research_rank_tasks ──────────────────────────────────────────────
--
-- One row per (keyword × location) SERP lookup submitted to DataForSEO's
-- Standard organic queue during the localize phase. Persisted so the Inngest
-- poller can correlate `tasks_ready` ids back to (keyword, location) and
-- resume across function recycles without re-submitting (and re-paying).
--
--   status: pending  — submitted to DFS, not yet collected
--           done      — task_get returned; `rank` holds the target's position
--                       (null = not in top depth)
--           failed    — submit or fetch errored

create table if not exists public.keyword_research_rank_tasks (
  id              uuid primary key default gen_random_uuid(),
  run_id          uuid not null references public.keyword_research_runs(id) on delete cascade,
  location_slug   text not null,
  location_code   integer not null,
  keyword         text not null,
  -- City-level Google Ads search volume for this (keyword, location). Persisted
  -- here so the final CSV assembly reads everything from one table.
  city_volume     integer,
  dfs_task_id     text,
  status          text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  rank            integer,
  created_at      timestamptz not null default now()
);

create index if not exists keyword_research_rank_tasks_run_idx
  on public.keyword_research_rank_tasks (run_id, status);

create index if not exists keyword_research_rank_tasks_dfs_idx
  on public.keyword_research_rank_tasks (dfs_task_id);
