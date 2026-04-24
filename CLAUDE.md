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
3. **Google Search Console** — query performance data per partner site. OAuth 2.0 via googleapis. Scope: `webmasters.readonly`.
4. **Google Analytics 4** — behavioral/conversion data (sessions, users, conversions, landing pages, traffic sources) per partner property. Shares the same OAuth client + refresh token as GSC. Scope: `analytics.readonly` (also covers the GA4 Admin API for property enumeration). Wrapped by `lib/ga4.ts`.
5. **Airtable** — source of truth for partner info (name, services, location, site URL, GA4 property ID, GSC siteUrl format). Read-only for MVP.

## Folder Structure
- `app/` — Next.js pages and API routes
  - `app/api/airtable/` — Airtable reads
  - `app/api/dataforseo/` — DataForSEO proxy (keeps keys server-side)
  - `app/api/gsc/` — GSC OAuth and search analytics
  - `app/api/ga4/` — GA4 Data API proxy (report + conversions-by-page)
  - `app/api/claude/` — Claude API calls
  - `app/keyword-research/`, `app/strategy/`, `app/content/`, `app/backlinks/`, `app/reporting/` — the five tabs
- `lib/` — typed clients and helpers (airtable.ts, claude.ts, dataforseo.ts, ga4.ts, gsc.ts, types.ts)
- `components/` — shared React components (PartnerSelector, TabNav, shadcn components in components/ui)

## Environment Variables
Deployed app: set in Vercel dashboard (Settings → Environment Variables).
Local dev: set in `.env.local` (never committed; template in `.env.example`).
- `ANTHROPIC_API_KEY`
- `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`
- `AIRTABLE_PAT`, `AIRTABLE_BASE_ID`, `AIRTABLE_PARTNERS_TABLE`
- `APP_PASSWORD`, `APP_AUTH_SECRET` (see Auth below)

## Auth
Single-password app-level gate in front of the entire app. This protects the production deployment because Vercel's free-tier "Vercel Authentication" only covers previews.

- **Password** lives in `APP_PASSWORD`. Whatever string you set there is what gets typed at `/login`. No user accounts, no email, nothing else.
- **Signing key** for the session cookie lives in `APP_AUTH_SECRET`. HMAC-SHA256. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
- Cookie is named `harbinger_auth`, httpOnly + Secure (in production) + SameSite=Lax, signed payload `{ iat, exp }`, **30-day expiry**. No refresh — re-login after 30 days.
- `proxy.ts` at the project root gates everything. Public bypass paths: `/login`, `/api/auth/login`, `/api/auth/logout`. Next.js internals (`/_next`, `/favicon.ico`) are excluded via the matcher. Unauthed HTML request → redirect to `/login?next=…`; unauthed `/api/*` → `401 { error: "unauthorized" }`.
- Fails closed: if `APP_PASSWORD` or `APP_AUTH_SECRET` is unset, no one can log in and everyone sees `/login`. Safer than failing open.
- Rate limit: 5 failed logins per IP per 10 minutes → `429`. In-memory per serverless instance (best-effort; Vercel cold starts reset it). Upgrade to Upstash/Redis if the threat model needs it.
- Logout: `POST /api/auth/logout` (200 JSON) or `GET /api/auth/logout` (302 to `/login`). Both clear the cookie.
- No auth library (NextAuth etc.) — handwritten in `lib/auth.ts` using `node:crypto`. Proxy defaults to Node.js runtime in Next 16, so `node:crypto` works there too.

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

## GA4 conventions
- **Property resolution is hybrid: auto-detect first, Airtable override second.** The default flow is `listProperties()` in `lib/ga4.ts` → for every GA4 property the authed account can see, fetch its web data streams and record the `webStreamData.defaultUri`. `lib/ga4-site-match.ts` then matches the partner's `website` hostname against each stream URL. For 95% of partners this resolves the property automatically with zero Airtable work.
- **Airtable `GA4 Property ID` field is an explicit override.** Populate it only when (a) the partner has multiple GA4 properties and auto-detect picks the wrong one, (b) the web stream's `defaultUri` doesn't match the public website (e.g. staging domain mapped to prod), or (c) Admin API enumeration is failing and you need to force a specific property. Values may be stored as a bare numeric ID (`"123456789"`) or the canonical resource name (`"properties/123456789"`) — both flow through `normalizePropertyId()` in `lib/ga4.ts`.
- **Property list is cached for 10 minutes** per serverless instance (`PROPERTY_CACHE_TTL_MS`). The first request pays the N+1 cost of enumerating streams across all properties (concurrency-capped at 10); subsequent requests are instant. Hit `/api/ga4/properties?refresh=1` to bust the cache after provisioning a new property.
- **Integration is optional per partner.** Code paths that use GA4 (`app/reporting`, `app/keyword-research`) must handle the "no match, no override" case gracefully: the Reporting tab shows a "GA4 not configured" badge and generates a GSC-only report; the Keyword Research tab skips the high-converting-page signal entirely.
- **No partner-side coordination needed.** The SEO Ops Google account that's authorized for GSC has Viewer access to every partner's GA4 property. The same OAuth refresh token drives both APIs; changing GA4 scope requires re-consent (see Auth / Deployment notes below).
- **Partner onboarding checklist** when adding a new partner record to Airtable:
  1. Profile, Services, Service Areas, Website populated.
  2. Partner Goals / Target Audience / Industry Knowledge populated (the record-template boilerplate starts with `**Template**` and is flagged in `Partner.unfilledContext`).
  3. Confirm the SEO Ops Google account has been granted Viewer on the GA4 property (usually already true, but check for new partners).
  4. After the first report generation, check the "GA4 property" dropdown on the Reporting tab: if it shows "auto-detected" with the right property, you're done. If it shows "GA4 not configured" or picks the wrong property, paste the property ID into Airtable's `GA4 Property ID` field as an explicit override.

## Instructions for Claude Code
- Always read this file before starting a task. If a prompt asks you to do something that conflicts with this file, stop and ask.
- Before making assumptions about Airtable field names, DataForSEO endpoint shapes, or GSC response formats, ask the user.
- After completing any task, explain what you changed and why, then tell the user what to test manually.
- If a task requires the user to do something outside Claude Code (e.g., "go to Google Cloud Console and copy this URL"), make the instructions explicit and numbered.
- If something fails, investigate root cause before retrying. Do not paper over errors with try/catch that swallows them.
- Never commit .env.local or any file containing real API keys.

## TODO (deferred work)
- **Prompt 8 (Keyword Research tab): Airtable → DataForSEO location format helper.** `Partner.serviceAreas` comes from Airtable as free-text "City, ST" or just "City" (see real data: "Greensboro and Winston Salem, North Carolina", "Peachtree City, GA", "Atlanta, Georgia"). DataForSEO's canonical format is `"City,FullStateName,United States"` (commas, no spaces). Add a helper in `lib/dataforseo.ts` (or `lib/locations.ts`) that takes a freeform string and returns the canonical form. Sufficient for MVP: a static US state abbrev → full name map (`{ GA: "Georgia", ... }`) plus a regex to extract "City, ST" from the first line of the field. If the parser can't match, fall back to the raw string and let DataForSEO surface the error — do not silently swap to a default location.
