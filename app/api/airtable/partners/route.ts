import { NextResponse } from "next/server"
import { getPartners } from "@/lib/airtable"

export const dynamic = "force-dynamic"

function errorMessage(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    return (error as { message: string }).message
  }
  return "Unknown error fetching partners"
}

export async function GET() {
  try {
    const partners = await getPartners()
    return NextResponse.json({ partners })
  } catch (error: unknown) {
    console.error("[api/airtable/partners] failed:", error)
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 })
  }
}
