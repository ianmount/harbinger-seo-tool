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

### Libraries added for the Audit tab
- **DataForSEO On-Page API** — site crawl (replaces the old cheerio + native-fetch crawler, which was being defeated by Cloudflare-class WAFs that returned stripped 200 challenge bodies). Auto-detects whether JS rendering is needed via `/v3/on_page/instant_pages`; static crawls run as-is, JS-rendered crawls add the surcharge. See `lib/dataforseo-onpage.ts`.
- **`cheerio`** — still used, but only for JSON-LD extraction on a sample (~16 pages) of raw HTML pulled from `/v3/on_page/raw_html`. No longer used for crawling. See `lib/schema-parse.ts`.
- **`@react-pdf/renderer`** — PDF output for the Audit tab. Pure JS, no Chromium dep. Fonts use built-in Helvetica; register custom fonts later via `Font.register`.
- **`@vercel/blob`** — public-with-unguessable-slug storage for the generated audit PDFs. Requires `BLOB_READ_WRITE_TOKEN`.
- **`fast-xml-parser`** — sitemap.xml / sitemap_index.xml parsing in `lib/sitemap.ts`. Sitemap/robots fetches still use native `fetch` because those endpoints aren't usually WAF-protected.

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
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REFRESH_TOKEN_PARTNERS` (existing partner pipeline) and `GOOGLE_REFRESH_TOKEN_ASSESSMENTS` (Assessment workflow — Audit + Competitive Analysis). Same OAuth client, two account-specific tokens. The auth factory in `lib/google-auth.ts` is the only place that reads either env var.
- `GOOGLE_PARTNERS_EMAIL`, `GOOGLE_ASSESSMENTS_EMAIL` — surfaced in error messages so prospects know who to share GSC/GA4 access with
- `AIRTABLE_PAT`, `AIRTABLE_BASE_ID`, `AIRTABLE_PARTNERS_TABLE`
- `APP_PASSWORD`, `APP_AUTH_SECRET` (see Auth below)
- `BLOB_READ_WRITE_TOKEN` (Audit tab only — Vercel Blob store; optional for the rest of the app)

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
Six tabs:
1. **Audit** (pre-sales deliverable) — prospect domain + markets → crawl + DataForSEO competitive/backlinks + optional GSC/GA4 → Claude synthesis → polished PDF (Vercel Blob). 5-7 findings hard constraint. ~$0.85–$1.00/audit. Audit synthesis uses `claude-sonnet-4-6` (Opus 4.7 timed out on the payload).
2. Keyword Research — GSC queries + DataForSEO volume/difficulty → scored keyword list
3. Strategy — approved keywords + partner profile → Claude-generated strategy doc
4. Content Production — page brief → Claude-generated technical package + body copy, with automatic JSON-LD schema validation and optional live-page GSC URL Inspection
5. Backlinks — competitor domains → DataForSEO backlinks → Claude-categorized prospects + outreach drafts
6. Reporting — partner + date range → GSC data + Claude narrative report

Note: `Prospect` (Audit tab, in-memory only) is distinct from `Partner` (Airtable-backed, used by tabs 2–6).

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

## Audit tab — in-progress state (branch `claude/add-seo-audit-tab-w4g9i`)

Pre-sales SEO audit tab that produces a polished PDF for a prospective partner. Subject is a `Prospect` (in-memory, not in Airtable), distinct from `Partner`. GSC/GA4 are optional per prospect; falls back to DataForSEO-only when absent. Crawl runs on **DataForSEO's On-Page API** (their crawl infrastructure bypasses the Cloudflare-class WAFs that were defeating the old native-fetch crawler). JS rendering is auto-detected via a single-page `instant_pages` probe — if the static probe returns title + description, we run a static crawl; otherwise we re-run with `enable_javascript: true`. Requires Vercel Pro for the 800s Fluid Compute function limit.

### Four up-front decisions (confirmed with user)
- **Crawler:** DataForSEO On-Page API. Public surface lives in `lib/audit-crawl.ts` (was `lib/crawler.ts`). JS rendering decided per-audit by the `instant_pages` probe — no manual flag.
- **PDF library:** `@react-pdf/renderer` — pure JS, no Chrome dep.
- **PDF storage:** Vercel Blob (public-via-unguessable-slug, ≥16 chars entropy). Requires `BLOB_READ_WRITE_TOKEN` env var.
- **Vercel plan:** Pro, 800s max function duration (Fluid Compute).

### Additional constraints
- Log actual DataForSEO + Claude cost per audit to server console. Surface total cost + duration in the PDF footer ("Audit generated in X minutes using verified first-party data") so the user can validate the per-audit cost estimate during pilot. **Cost has moved up vs. the old crawler:** budget **~$1.00–$2.50/audit** depending on site size and whether JS rendering kicks in (static crawl ≈ +$0.10–0.50, JS-rendered ≈ +$0.30–1.50 above the previous Claude + competitive/backlink baseline).
- Audit synthesis uses **`claude-sonnet-4-6`** (not Opus 4.7). Opus was hitting stream-idle timeouts on the 30-40k-token audit payload; Sonnet streams faster and is sufficient for structured JSON output. If finding quality regresses, swap back to Opus with a different workaround (shorter prompt, chunked synthesis).
- Hard constraint: Claude produces EXACTLY 5-7 findings. Extras go into `appendixIssues` as one-liners. Validated server-side — route returns 502 if the count is wrong.
- Every finding must cite a specific URL/count/percentage from the data. Generic claims forbidden.
- At least one finding must name a competitor domain.
- Backlink risk must list 3-5 actual spam domain strings from the data.
- Business-impact framing: if GA4 conversions are configured, translate traffic findings to leads/revenue. If not, acknowledge the gap.
- 90-day roadmap must reference findings by number ("Resolves Finding #3").
- **Schema coverage is sample-based** (~16 raw-HTML samples per audit: homepage + up to 4 reps each from service / location / blog buckets). DataForSEO's `/v3/on_page/pages` doesn't expose JSON-LD, so we pull raw HTML for representative URLs and parse with cheerio (`lib/schema-parse.ts`). Trade-off: long-tail pages outside the sample contribute zero schema signal. Acceptable for the audit's narrative; revisit if a finding requires per-page schema fidelity.

### Implementation status
- **Completed:**
  - `lib/types.ts` — `Prospect`, `TargetMarket`, `CrawledPage`, `CrawlReport`, `DomainRankOverview`, `CompetitiveRow`, `CompetitiveReport`, `ReferringDomainSample`, `BacklinkReport`, `AuditGscSlice`, `AuditGa4Slice`, `AuditFinding`, `AuditSynthesis`, etc.
  - `lib/audit-crawl.ts` — public crawl entry point. Orchestrates sitemap discovery (`lib/sitemap.ts`), JS-render auto-detect (`lib/dataforseo-onpage.ts` / `instant_pages`), the multi-page On-Page crawl, link-graph fetch, raw-HTML schema sampling, and shape adaptation back to the legacy `CrawlResults` interface (`lib/onpage-to-crawl.ts`).
  - `lib/dataforseo-onpage.ts` — On-Page API client (`instant_pages`, `task_post`, `summary` polling, `pages`, `links`, `raw_html`). Same auth + 429-retry pattern as `lib/dataforseo.ts`. Schemas use `.passthrough()` and `.optional()` liberally because the documented response shape is best-effort.
  - `lib/schema-parse.ts` — cheerio-based JSON-LD extraction + `buildSchemaCoverageMatrix` + the page-classification helpers.
  - `lib/sitemap.ts` — robots.txt + sitemap.xml / sitemap_index.xml discovery via native fetch (these endpoints aren't typically WAF-protected).
  - `lib/dataforseo.ts` — added `domainRankOverview`, `rankedKeywords`, `serpCompetitors`, `backlinksSummary`, `referringDomainsWithSpamScore`. Competitive rollup runs at **state granularity** (not city) because Labs endpoints reject city-level location names — PDF still labels each row with the original city.
  - `lib/audit-cost.ts` — per-audit cost accumulator using `AsyncLocalStorage`. `lib/claude.ts` + `lib/dataforseo.ts` + `lib/dataforseo-onpage.ts` report into it via `recordClaudeCost` / `recordDataForSEOCost`. Route wraps pipeline with `withAuditCost(...)`.
  - `app/api/audit/crawl/route.ts` — POST, `maxDuration=800`. Delegates to `crawlSite` (now from `@/lib/audit-crawl`).
  - `lib/dataforseo.ts` — added `domainRankOverview`, `rankedKeywords`, `serpCompetitors`, `backlinksSummary`, `referringDomainsWithSpamScore`. Competitive rollup runs at **state granularity** (not city) because Labs endpoints reject city-level location names — PDF still labels each row with the original city.
  - `lib/audit-cost.ts` — per-audit cost accumulator using `AsyncLocalStorage`. `lib/claude.ts` + `lib/dataforseo.ts` report into it via `recordClaudeCost` / `recordDataForSEOCost`. Route wraps pipeline with `withAuditCost(...)`.
  - `app/api/audit/crawl/route.ts` — POST, `maxDuration=300`. Delegates to `crawlSite`.
  - `app/api/audit/competitive/route.ts` — POST, `maxDuration=300`. Optional auto-suggestion via `proposeCompetitors()` when `competitors: []`.
  - `app/api/audit/backlinks/route.ts` — POST, `maxDuration=60`. Delegates to `referringDomainsWithSpamScore`.
  - `app/api/claude/audit/route.ts` — POST, `maxDuration=300`. Uses `claude-sonnet-4-6`. Builds prompt, parses JSON, validates 5-7 findings invariant, returns `{ synthesis }`.
- **Still to do on this branch:**
  - `lib/audit-pdf.ts` — React-PDF document component, navy + orange Inter-alike, pages: cover, exec summary, traffic analysis (if GA4), competitive table (money shot), technical findings, backlink risk, 90-day roadmap. Footer shows generation time + cost note.
  - `app/api/audit/pdf/route.ts` — orchestrator: calls crawl → competitive → backlinks → optional GSC/GA4 → Claude synthesis → render PDF → upload to Vercel Blob. Returns `{ url, synthesis, costUsd, durationSeconds }`. Wraps everything in `withAuditCost`.
  - `app/audit/page.tsx` — form (domain, markets, competitors, optional GSC/GA4 IDs), multi-stage progress indicator, PDF preview + download + copy-link.
  - `components/TabNav.tsx` — add `/audit` as **first** tab.
  - `lib/env.ts` + `.env.example` — add `BLOB_READ_WRITE_TOKEN` (optional).
  - Test build + push.
- **User owes when we get to Blob step:** create a Blob store in Vercel dashboard (Storage → Create → Blob), name it `audit-reports`, paste the `BLOB_READ_WRITE_TOKEN` into Vercel env vars (Settings → Environment Variables). I will spell out the exact steps when we hit that point.
