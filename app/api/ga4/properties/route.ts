import { NextResponse } from "next/server"
import { GA4Error, listProperties } from "@/lib/ga4"

export const dynamic = "force-dynamic"

function statusFromGA4Error(error: GA4Error): number {
  switch (error.code) {
    case "NO_REFRESH_TOKEN":
      return 503
    case "FORBIDDEN":
      return 403
    default:
      return error.status ?? 502
  }
}

export async function GET(request: Request) {
  // ?refresh=1 bypasses the in-memory cache. Useful right after a new
  // property is provisioned in Google Analytics.
  const forceRefresh = new URL(request.url).searchParams.get("refresh") === "1"
  try {
    const properties = await listProperties({ account: "partners", forceRefresh })
    return NextResponse.json({ properties })
  } catch (error: unknown) {
    console.error("[api/ga4/properties] failed:", error)
    if (error instanceof GA4Error) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: statusFromGA4Error(error) },
      )
    }
    const message = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
