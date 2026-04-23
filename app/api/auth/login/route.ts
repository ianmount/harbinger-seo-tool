import { NextResponse } from "next/server"
import { z } from "zod"
import {
  clearFailedAttempts,
  COOKIE_MAX_AGE_SECONDS,
  COOKIE_NAME,
  getAppPassword,
  getAuthSecret,
  getClientIp,
  isRateLimited,
  passwordsMatch,
  recordFailedAttempt,
  signToken,
} from "@/lib/auth"

export const dynamic = "force-dynamic"

const bodySchema = z.object({
  password: z.string().min(1),
})

export async function POST(request: Request) {
  const ip = getClientIp(request)

  if (isRateLimited(ip)) {
    console.warn(`[auth] rate-limited login attempt from ${ip}`)
    return NextResponse.json(
      { error: "too many failed attempts, try again later" },
      { status: 429 },
    )
  }

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return NextResponse.json(
      { error: "request body must be valid JSON" },
      { status: 400 },
    )
  }

  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid request body" },
      { status: 400 },
    )
  }

  const expected = getAppPassword()
  const secret = getAuthSecret()
  if (!expected || !secret) {
    console.error(
      "[auth] APP_PASSWORD or APP_AUTH_SECRET not set; cannot authenticate",
    )
    return NextResponse.json(
      { error: "auth is not configured on the server" },
      { status: 503 },
    )
  }

  if (!passwordsMatch(expected, parsed.data.password)) {
    recordFailedAttempt(ip)
    console.warn(`[auth] failed login attempt from ${ip}`)
    return NextResponse.json({ error: "invalid password" }, { status: 401 })
  }

  clearFailedAttempts(ip)
  const token = signToken(secret, COOKIE_MAX_AGE_SECONDS)

  const response = NextResponse.json({ ok: true })
  response.cookies.set({
    name: COOKIE_NAME,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
  })
  return response
}
