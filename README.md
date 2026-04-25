# Harbinger SEO Tool

Internal tool for Harbinger Marketing's SEO engineer to run the full 6-month SEO cycle for local service business partners. Five tabs wrap four external APIs (Anthropic, DataForSEO, Google Search Console, Airtable).

See `CLAUDE.md` for full project context, architecture, and conventions.

## Stack

Next.js 16 (App Router, TypeScript strict) + Tailwind v4 + shadcn/ui. See `CLAUDE.md` → Tech Stack for version specifics and the shadcn manual-install note.

## Local development

```bash
npm install
cp .env.example .env.local   # then fill in real values
npm run dev                  # http://localhost:3000
```

Two of the four external API hosts (`api.airtable.com`, `api.dataforseo.com`) are blocked by the Claude Code sandbox egress allowlist, so local dev inside the sandbox cannot fully exercise those clients. Outside the sandbox (a normal dev laptop), local dev works against all four APIs.

## Deployment (Vercel)

Production URL: **https://harbinger-seo-tool.vercel.app**

Vercel auto-detects Next.js — no `vercel.json` or custom build config. The default `next build` from `package.json` scripts is what runs.

### Triggering a deploy

- **Production:** push to `main`. Vercel rebuilds and redeploys automatically.
- **Preview:** push to any other branch. Vercel creates a preview URL per branch.

### Viewing logs

1. https://vercel.com → the `harbinger-seo-tool` project → **Deployments** tab.
2. Click the deployment you want.
3. Two tabs of interest:
   - **Build Logs** — for compile/install errors.
   - **Runtime Logs** (or "Logs" on Function pages) — for errors and `console.log` output from API routes.

### Adding or updating environment variables

1. Vercel dashboard → the project → **Settings** → **Environment Variables**.
2. Add/edit the variable. Choose which environments it applies to (Production, Preview, Development).
3. **Env var changes only take effect on the next deploy.** After updating, either push a commit or click **Redeploy** on the most recent deployment in the Deployments tab.

The full list of env vars the app expects is in `.env.example`. Vercel exposes `VERCEL_URL` at runtime (e.g. `harbinger-seo-tool.vercel.app`) — routes that need the canonical app URL (such as OAuth redirect URIs) should derive it from `VERCEL_URL` and fall back to `localhost:3000` for local dev.

### Quick checks after a deploy

- `GET /api/health` → `{ ok: true, envPresent: {...} }` reports whether each service's env keys are populated. Use this to confirm a redeploy picked up env-var changes.

## Two-account Google OAuth

The tool authenticates with two separate Google accounts that share **one** Google Cloud OAuth client (one `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`):

| Account     | Email                              | Refresh-token env var               | Used by                                                |
| ----------- | ---------------------------------- | ----------------------------------- | ------------------------------------------------------ |
| Partners    | access@harbingermarketing.com      | `GOOGLE_REFRESH_TOKEN_PARTNERS`     | Existing partner pipeline (Reporting, Keyword Research) |
| Assessments | audit@harbingermarketing.com       | `GOOGLE_REFRESH_TOKEN_ASSESSMENTS`  | Assessment workflow (Audit, Comp Analysis tabs)         |

The auth factory in `lib/google-auth.ts` is the **only** place in the codebase that reads either refresh-token env var. Every GSC / GA4 call passes an `account: 'partners' | 'assessments'` parameter explicitly, so the call site is responsible for picking the right Google identity.

### Minting a refresh token

For each account you want to enable, run:

```bash
# 1. Make sure GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET are present in
#    .env.local. Then run the OAuth setup script:
node --env-file=.env.local scripts/oauth-setup.js --label partners
# or:
node --env-file=.env.local scripts/oauth-setup.js --label assessments
```

The script:

1. Spins up a tiny HTTP server on `localhost:3000`.
2. Opens your browser to Google's consent page.
3. Sign in as the **matching** Google account (partners email vs. assessments email).
4. Grants Search Console + GA4 read scope.
5. Prints the resulting refresh token to your terminal and tells you which env var to set.

Paste the printed token into Vercel (Settings → Environment Variables) **and** into your local `.env.local` if you want local dev to work. Trigger a redeploy on Vercel for the change to take effect.

### Prospect onboarding (assessments account)

Before running an Audit against a new prospect, the prospect must add `audit@harbingermarketing.com` to:

- **Search Console** — Settings → Users and permissions → Add user → Restricted (or higher).
- **GA4** — Admin → Property Access Management → Add user → Viewer (Property level).

If neither is shared yet, the Audit will still run and surface a warning naming the assessments email; the audit will fall back to crawl data only.

### Rotating a token

Revoke at <https://myaccount.google.com/permissions> while signed in as the matching account, then re-run the script for that label.
