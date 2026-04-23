# Harbinger SEO Tool — Project Context

## Purpose
An internal tool for Harbinger Marketing's SEO engineer to run the full 6-month SEO cycle for ~100 local service business partners. Replaces work currently done by an external vendor. MVP scope: five tabs wrapping four external APIs.

## Tech Stack
- Next.js 14+ with App Router and TypeScript (strict mode). This project is on Next.js 16.2.4 with React 19 and Tailwind v4 — APIs, conventions, and file structure may differ from training data for earlier Next versions. Read the relevant guide in `node_modules/next/dist/docs/` before writing Next-specific code. Heed deprecation notices.
- Tailwind CSS + shadcn/ui for styling and primitives. **shadcn was installed manually, not via `npx shadcn init`**, because the sandbox allowlist blocks `ui.shadcn.com`. Components were fetched from `https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/registry/new-york-v4/ui/`. Style is `new-york` (the only style available for Tailwind v4); base color is `slate`; CSS variables live in `app/globals.css` under `:root` and `.dark`. To add a new component in the future: (a) ask the user to add `ui.shadcn.com` to the sandbox allowlist and then run `npx shadcn@latest add <name>`, OR (b) fetch `components/ui/<name>.tsx` from the same GitHub raw URL and rewrite any `@/registry/new-york-v4/ui/*` imports to `@/components/ui/*`. Note: upstream replaced `toast` with `sonner` — use `sonner` for toast notifications.
- Node 20+ runtime
- Airtable SDK, Anthropic SDK, googleapis package, native fetch for DataForSEO
- Deployed to Vercel (see Deployment & Dev Workflow below); not localhost-only anymore

## Deployment & Dev Workflow
- Deployed to Vercel at **https://harbinger-seo-tool.vercel.app**. Every push to `main` triggers an automatic production redeploy; pushes to other branches create preview deploys.
- **Env vars for the deployed app live in the Vercel dashboard** (Settings → Environment Variables), NOT in `.env.local`. `.env.local` is kept in the repo root as a template for local dev only; it is not the source of truth for the deployed app.
- Primary test target is the Vercel URL. The sandbox's own localhost is not usable for external APIs — two of the four external hosts (`api.airtable.com`, `api.dataforseo.com`) are blocked by the Claude Code sandbox egress allowlist. Vercel has full network access, so the deployed app can reach all four.
- To view logs: Vercel dashboard → Deployments → click the deployment → Logs tab (build logs and runtime/function logs are separate tabs there).
- To add/update an env var: Vercel dashboard → Settings → Environment Variables. Changes take effect only on the next deploy, so trigger a redeploy after updating (push a commit, or "Redeploy" button on the latest deployment).
- If a route depends on `VERCEL_URL` / similar runtime-only vars (e.g. OAuth redirect URIs), branch on `process.env.VERCEL_URL` to build `https://${VERCEL_URL}` and fall back to `http://localhost:3000` when not set.

## External APIs
1. **Anthropic Claude** — strategy, content generation, outreach drafts, report narratives. Use `claude-opus-4-7` unless the user says otherwise.
2. **DataForSEO** — keyword research (volume, difficulty, suggestions), SERP data, backlink research. Basic Auth with login+password.
3. **Google Search Console** — query performance data per partner site. OAuth 2.0 via googleapis.
4. **Airtable** — source of truth for partner info (name, services, location, site URL, GSC siteUrl format). Read-only for MVP.

## Folder Structure
- `app/` — Next.js pages and API routes
  - `app/api/airtable/` — Airtable reads
  - `app/api/dataforseo/` — DataForSEO proxy (keeps keys server-side)
  - `app/api/gsc/` — GSC OAuth and search analytics
  - `app/api/claude/` — Claude API calls
  - `app/keyword-research/`, `app/strategy/`, `app/content/`, `app/backlinks/`, `app/reporting/` — the five tabs
- `lib/` — typed clients and helpers (airtable.ts, claude.ts, dataforseo.ts, gsc.ts, types.ts)
- `components/` — shared React components (PartnerSelector, TabNav, shadcn components in components/ui)

## Environment Variables
Deployed app: set in Vercel dashboard (Settings → Environment Variables).
Local dev: set in `.env.local` (never committed; template in `.env.example`).
- `ANTHROPIC_API_KEY`
- `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`
- `AIRTABLE_PAT`, `AIRTABLE_BASE_ID`, `AIRTABLE_PARTNERS_TABLE`

## Coding Conventions
- TypeScript strict mode. No `any` types — use `unknown` and narrow, or define proper types.
- All API calls happen server-side in `app/api/` routes. Never call external APIs from client components.
- Use Zod for runtime validation of external API responses.
- Every external API call must have explicit error handling and return a typed result.
- UI components that fetch data should show loading states and handle errors gracefully.
- Use shadcn components for all primitives (buttons, selects, tables, etc.). Do not hand-roll these.

## MVP Scope — What's Included
Five tabs, each wrapping one workflow:
1. Keyword Research — GSC queries + DataForSEO volume/difficulty → scored keyword list
2. Strategy — approved keywords + partner profile → Claude-generated strategy doc
3. Content Production — page brief → Claude-generated technical package + body copy, with automatic JSON-LD schema validation and optional live-page GSC URL Inspection
4. Backlinks — competitor domains → DataForSEO backlinks → Claude-categorized prospects + outreach drafts
5. Reporting — partner + date range → GSC data + Claude narrative report

## MVP Scope — What's NOT Included
- No database / persistent storage in the tool itself. Outputs that need to survive sessions are written to Airtable.
- No technical SEO auditing (site crawling, canonical checks, etc.)
- No Google Business Profile integration
- No multi-user authentication — single engineer, single machine
- No background jobs or queues — all actions are synchronous
- No outreach email sending — drafts only

## Instructions for Claude Code
- Always read this file before starting a task. If a prompt asks you to do something that conflicts with this file, stop and ask.
- Before making assumptions about Airtable field names, DataForSEO endpoint shapes, or GSC response formats, ask the user.
- After completing any task, explain what you changed and why, then tell the user what to test manually.
- If a task requires the user to do something outside Claude Code (e.g., "go to Google Cloud Console and copy this URL"), make the instructions explicit and numbered.
- If something fails, investigate root cause before retrying. Do not paper over errors with try/catch that swallows them.
- Never commit .env.local or any file containing real API keys.
