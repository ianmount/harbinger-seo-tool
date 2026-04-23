import { NextResponse, type NextRequest } from "next/server"
import { COOKIE_NAME, PUBLIC_PATHS, verifyToken } from "@/lib/auth"

// Next.js 16 renamed the middleware file convention to `proxy` (middleware.ts
// is deprecated). Proxy defaults to the Node.js runtime in v16, so `node:crypto`
// works natively inside verifyToken() via the shared lib/auth module.

function isPublicPath(pathname: string): boolean {
  return (PUBLIC_PATHS as readonly string[]).includes(pathname)
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (isPublicPath(pathname)) {
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
