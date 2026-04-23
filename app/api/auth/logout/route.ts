import { NextResponse } from "next/server"
import { COOKIE_NAME } from "@/lib/auth"

export const dynamic = "force-dynamic"

function clearCookie(response: NextResponse) {
  response.cookies.set({
    name: COOKIE_NAME,
    value: "",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  })
}

export async function POST() {
  const response = NextResponse.json({ ok: true })
  clearCookie(response)
  return response
}

export async function GET(request: Request) {
  const response = NextResponse.redirect(new URL("/login", request.url))
  clearCookie(response)
  return response
}
