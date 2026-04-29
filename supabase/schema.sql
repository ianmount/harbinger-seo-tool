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
