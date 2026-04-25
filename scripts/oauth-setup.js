#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * Google OAuth setup script.
 *
 * Mints a refresh token for one of the tool's two Google accounts. Runs as
 * a tiny Node HTTP server that hosts the consent redirect URI locally,
 * opens the browser to Google's consent page, and prints the resulting
 * refresh token to stdout so you can paste it into Vercel.
 *
 * Usage:
 *   node scripts/oauth-setup.js --label partners
 *   node scripts/oauth-setup.js --label assessments
 *
 * The --label flag is purely cosmetic — Google doesn't know about it. It
 * just controls which env var name the script tells you to set at the end:
 *
 *   --label partners     →  GOOGLE_REFRESH_TOKEN_PARTNERS
 *   --label assessments  →  GOOGLE_REFRESH_TOKEN_ASSESSMENTS
 *
 * Sign in as the matching Google account in the consent window. Paste the
 * printed token into your environment (Vercel dashboard for prod, .env.local
 * for dev) and redeploy.
 *
 * Prereqs:
 *   - GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET set in env (or .env.local
 *     loaded via `node --env-file=.env.local scripts/oauth-setup.js ...`).
 *   - http://localhost:3000/api/gsc/callback added to the OAuth client's
 *     authorized redirect URIs in Google Cloud Console.
 */

const http = require("node:http")
const { URL } = require("node:url")
const { spawn } = require("node:child_process")

const SCOPES = [
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/analytics.readonly",
]
const REDIRECT_URI = "http://localhost:3000/api/gsc/callback"
const PORT = 3000

function parseArgs(argv) {
  const args = { label: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--label") {
      args.label = argv[++i] ?? null
    } else if (arg.startsWith("--label=")) {
      args.label = arg.slice("--label=".length)
    }
  }
  return args
}

function envVarName(label) {
  if (label === "partners") return "GOOGLE_REFRESH_TOKEN_PARTNERS"
  if (label === "assessments") return "GOOGLE_REFRESH_TOKEN_ASSESSMENTS"
  return "GOOGLE_REFRESH_TOKEN_<LABEL>"
}

function buildAuthUrl(clientId) {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth")
  url.searchParams.set("client_id", clientId)
  url.searchParams.set("redirect_uri", REDIRECT_URI)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("scope", SCOPES.join(" "))
  url.searchParams.set("access_type", "offline")
  url.searchParams.set("prompt", "consent")
  return url.toString()
}

async function exchangeCode(code, clientId, clientSecret) {
  const params = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
  })
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Token exchange failed (${res.status}): ${text}`)
  }
  return res.json()
}

function openBrowser(url) {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open"
  try {
    const child = spawn(cmd, [url], { detached: true, stdio: "ignore" })
    child.unref()
  } catch {
    // Fall through — caller logs the URL anyway.
  }
}

async function main() {
  const { label } = parseArgs(process.argv.slice(2))
  if (label !== "partners" && label !== "assessments") {
    console.error(
      "Usage: node scripts/oauth-setup.js --label <partners|assessments>",
    )
    process.exit(2)
  }

  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    console.error(
      "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET must be set in env. Try:\n  node --env-file=.env.local scripts/oauth-setup.js --label " +
        label,
    )
    process.exit(2)
  }

  const authUrl = buildAuthUrl(clientId)
  const targetEnv = envVarName(label)

  console.log(`\nMinting refresh token for the "${label}" account.`)
  console.log(`Sign in as the ${label} Google account in the browser window.`)
  console.log(`If the browser doesn't open automatically, open this URL:\n`)
  console.log(authUrl)
  console.log("")

  const codePromise = new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url ?? "/", `http://localhost:${PORT}`)
        if (url.pathname !== "/api/gsc/callback") {
          res.writeHead(404)
          res.end("Not found")
          return
        }
        const code = url.searchParams.get("code")
        const err = url.searchParams.get("error")
        if (err) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
          res.end(`<h1>OAuth error: ${err}</h1><p>You can close this tab.</p>`)
          server.close()
          reject(new Error(`OAuth error: ${err}`))
          return
        }
        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
          res.end("<h1>Missing ?code</h1>")
          server.close()
          reject(new Error("Missing ?code in OAuth redirect"))
          return
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        res.end(
          `<h1>OAuth complete</h1><p>You can close this tab and return to your terminal.</p>`,
        )
        server.close()
        resolve(code)
      } catch (e) {
        server.close()
        reject(e)
      }
    })
    server.listen(PORT, "127.0.0.1", () => {
      openBrowser(authUrl)
    })
    server.on("error", (e) => reject(e))
  })

  const code = await codePromise
  const tokens = await exchangeCode(code, clientId, clientSecret)

  if (!tokens.refresh_token) {
    console.error(
      "\nNo refresh_token returned. Google probably reused an existing grant. Revoke the app at https://myaccount.google.com/permissions and re-run this script.",
    )
    process.exit(1)
  }

  console.log("\n=== refresh token ===")
  console.log(tokens.refresh_token)
  console.log("======================\n")
  console.log(`Set this in your environment as:`)
  console.log(`  ${targetEnv}=${tokens.refresh_token}`)
  console.log("")
  console.log(
    `For Vercel: dashboard → Settings → Environment Variables → add ${targetEnv}.`,
  )
  console.log(`For local dev: paste into .env.local. Then redeploy.`)
}

main().catch((err) => {
  console.error("\nOAuth setup failed:", err.message ?? err)
  process.exit(1)
})
