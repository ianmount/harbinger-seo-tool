import { NextResponse } from "next/server"
import { GSCError, listSites } from "@/lib/gsc"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const sites = await listSites()
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
