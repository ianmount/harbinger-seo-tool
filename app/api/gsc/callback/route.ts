import { NextResponse } from "next/server"
import { exchangeCodeForTokens } from "@/lib/gsc"

export const dynamic = "force-dynamic"

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function renderHtml(title: string, bodyInner: string, status = 200) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 720px; margin: 3rem auto; padding: 0 1.5rem; line-height: 1.55; }
  h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
  h2 { font-size: 1.05rem; margin-top: 2rem; }
  .warning { background: #fff4d1; border-left: 4px solid #d97706; padding: 0.75rem 1rem; border-radius: 4px; margin: 1rem 0 1.5rem; font-size: 0.92rem; }
  .error { background: #fee2e2; border-left: 4px solid #dc2626; padding: 0.75rem 1rem; border-radius: 4px; }
  label { display: block; font-weight: 600; margin-bottom: 0.4rem; font-size: 0.9rem; }
  textarea { width: 100%; box-sizing: border-box; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.88rem; padding: 0.6rem; border: 1px solid #cbd5e1; border-radius: 4px; background: #f8fafc; resize: vertical; }
  textarea:focus { outline: 2px solid #2563eb; outline-offset: 1px; }
  button { margin-top: 0.5rem; padding: 0.5rem 0.9rem; background: #1e293b; color: white; border: 0; border-radius: 4px; font-size: 0.9rem; cursor: pointer; }
  button:hover { background: #334155; }
  #copied { display: none; margin-left: 0.6rem; font-size: 0.88rem; color: #16a34a; }
  ol { padding-left: 1.2rem; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #f1f5f9; padding: 0.08rem 0.35rem; border-radius: 3px; font-size: 0.88rem; }
  @media (prefers-color-scheme: dark) {
    body { background: #0b0f14; color: #e2e8f0; }
    textarea { background: #0f172a; border-color: #334155; color: #e2e8f0; }
    code { background: #1e293b; color: #e2e8f0; }
    .warning { background: #3b2f0a; color: #fde68a; }
    .error { background: #3b0b0b; color: #fecaca; }
  }
</style>
</head>
<body>
${bodyInner}
</body>
</html>`
  return new NextResponse(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  })
}

function renderError(message: string) {
  const body = `
<h1>GSC OAuth failed</h1>
<div class="error">${escapeHtml(message)}</div>
<p>Start over at <code>/api/gsc/auth</code>.</p>
`
  return renderHtml("GSC OAuth failed", body, 400)
}

function renderMissingRefreshToken() {
  const body = `
<h1>OAuth completed, but no refresh token was returned</h1>
<div class="error">Google did not send a <code>refresh_token</code> in the response. This usually means the account has previously authorized this app and Google is reusing the existing grant.</div>
<h2>How to fix</h2>
<ol>
  <li>Go to <a href="https://myaccount.google.com/permissions" rel="noopener">https://myaccount.google.com/permissions</a>.</li>
  <li>Remove access for this OAuth app.</li>
  <li>Revisit <code>/api/gsc/auth</code> and complete the consent flow again.</li>
</ol>
`
  return renderHtml("OAuth partially succeeded", body, 200)
}

function renderSuccess(refreshToken: string) {
  const body = `
<h1>Google OAuth complete</h1>
<div class="warning"><strong>This refresh token grants read access to Google Search Console + GA4 data for whichever account you just signed in with.</strong> Do not share it, do not commit it to git, do not paste it into chat. Put it in Vercel's Environment Variables only.</div>
<label for="token">Refresh token (click the box to select, then Ctrl/Cmd+C — or use the copy button)</label>
<textarea id="token" readonly rows="3" onclick="this.select()">${escapeHtml(refreshToken)}</textarea>
<button type="button" id="copy-btn">Copy to clipboard</button>
<span id="copied">Copied.</span>
<h2>Next steps</h2>
<ol>
  <li>Copy the token above.</li>
  <li>Open the Vercel dashboard → project → <strong>Settings → Environment Variables</strong>.</li>
  <li>If you signed in as the <strong>partners</strong> account: set <code>GOOGLE_REFRESH_TOKEN_PARTNERS</code> to this value.<br>
      If you signed in as the <strong>assessments</strong> account: set <code>GOOGLE_REFRESH_TOKEN_ASSESSMENTS</code> instead.</li>
  <li>Trigger a redeploy (push a commit, or use the Redeploy button on the latest deployment).</li>
  <li>After the deploy finishes, hit <code>/api/gsc/sites</code>. You should get back your accessible GSC properties.</li>
</ol>
<h2>If you need to rotate</h2>
<p>Revoke the grant at <a href="https://myaccount.google.com/permissions" rel="noopener">https://myaccount.google.com/permissions</a>, then revisit <code>/api/gsc/auth</code> to mint a new refresh token.</p>
<script>
  document.getElementById("copy-btn").addEventListener("click", async function () {
    const ta = document.getElementById("token");
    try {
      await navigator.clipboard.writeText(ta.value);
    } catch {
      ta.select();
      document.execCommand("copy");
    }
    const indicator = document.getElementById("copied");
    indicator.style.display = "inline";
    setTimeout(function () { indicator.style.display = "none"; }, 1800);
  });
</script>
`
  return renderHtml("GSC OAuth complete", body)
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const code = url.searchParams.get("code")
  const errParam = url.searchParams.get("error")

  if (errParam) {
    return renderError(`Google returned an error: ${errParam}`)
  }
  if (!code) {
    return renderError("Missing ?code query parameter. Start over at /api/gsc/auth.")
  }

  try {
    const tokens = await exchangeCodeForTokens(code)
    if (!tokens.refresh_token) {
      return renderMissingRefreshToken()
    }
    return renderSuccess(tokens.refresh_token)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error exchanging code"
    console.error("[api/gsc/callback] token exchange failed:", error)
    return renderError(`Token exchange failed: ${message}`)
  }
}
