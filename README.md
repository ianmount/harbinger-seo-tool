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
