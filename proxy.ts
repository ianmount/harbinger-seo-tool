import { NextResponse, type NextRequest } from "next/server"
import { timingSafeEqual } from "node:crypto"
import { COOKIE_NAME, PUBLIC_PATHS, verifyToken } from "@/lib/auth"

// Next.js 16 renamed the middleware file convention to `proxy` (middleware.ts
// is deprecated). Proxy defaults to the Node.js runtime in v16, so `node:crypto`
// works natively inside verifyToken() via the shared lib/auth module.

function isPublicPath(pathname: string): boolean {
  if ((PUBLIC_PATHS as readonly string[]).includes(pathname)) return true
  // Inngest serve handler — Inngest Cloud invokes this without our auth
  // cookie. Authentication is handled inside the SDK via INNGEST_SIGNING_KEY,
  // which verifies that requests are signed by Inngest's infrastructure.
  if (pathname === "/api/inngest" || pathname.startsWith("/api/inngest/")) {
    return true
  }
  return false
}

/**
 * Bearer-token auth for the Claude Code desktop Routine that drives
 * scheduled tasks. The Routine runs from the user's machine and can't
 * carry the cookie set by /login, so we accept `Authorization: Bearer
 * <ROUTINE_API_TOKEN>` for the routine-facing API prefixes only.
 *
 * Allowed prefixes:
 *   /api/scheduled-tasks/   — current dispatcher (sweeps task_schedules,
 *                             fires audits + crawls in one call)
 *   /api/technical-crawls/  — legacy endpoint kept around so existing
 *                             desktop routines don't break before users
 *                             update the bot to point at the new path
 *
 * Constant-time compare via timingSafeEqual to avoid a length-leaking
 * shortcut.
 */
const ROUTINE_PREFIXES = [
  "/api/scheduled-tasks/",
  "/api/technical-crawls/",
] as const

function isRoutineAuthorized(request: NextRequest, pathname: string): boolean {
  if (!ROUTINE_PREFIXES.some((p) => pathname.startsWith(p))) return false
  const expected = process.env.ROUTINE_API_TOKEN
  if (!expected) return false
  const header = request.headers.get("authorization")
  if (!header || !header.toLowerCase().startsWith("bearer ")) return false
  const presented = header.slice(7).trim()
  if (!presented) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(presented)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (isPublicPath(pathname)) {
    return NextResponse.next()
  }

  if (isRoutineAuthorized(request, pathname)) {
    return NextResponse.next()
  }

  const secret = process.env.APP_AUTH_SECRET
  const token = request.cookies.get(COOKIE_NAME)?.value
  const authed = secret ? verifyToken(secret, token) !== null : false

  if (authed) {
    return NextResponse.next()
  }

  // Fail closed. If APP_AUTH_SECRET is unset, every request is treated as
  // unauthenticated — safer than accidentally opening everything up.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }

  const loginUrl = new URL("/login", request.url)
  if (pathname !== "/" && pathname.startsWith("/")) {
    loginUrl.searchParams.set("next", pathname + request.nextUrl.search)
  }
  return NextResponse.redirect(loginUrl)
}

// Run on every request except Next.js internals and the favicon. Public bypass
// paths (login page, login/logout API) are handled inside the function above.
export const config = {
  matcher: ["/((?!_next|favicon\\.ico).*)"],
}
