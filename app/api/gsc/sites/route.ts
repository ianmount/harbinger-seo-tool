import { NextResponse } from "next/server"
import { GSCError, listSites } from "@/lib/gsc"
import type { GoogleAccount } from "@/lib/google-auth"

export const dynamic = "force-dynamic"

function parseAccount(value: string | null): GoogleAccount {
  return value === "assessments" ? "assessments" : "partners"
}

export async function GET(request: Request) {
  const account = parseAccount(
    new URL(request.url).searchParams.get("account"),
  )
  try {
    const sites = await listSites(account)
    return NextResponse.json({ sites })
  } catch (error: unknown) {
    console.error("[api/gsc/sites] failed:", error)
    if (error instanceof GSCError) {
      const status =
        error.code === "NO_REFRESH_TOKEN" ? 503 : error.status ?? 502
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status },
      )
    }
    const message = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
