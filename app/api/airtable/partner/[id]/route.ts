import { NextResponse } from "next/server"
import { getPartner } from "@/lib/airtable"

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
  return "Unknown error fetching partner"
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  try {
    const partner = await getPartner(id)
    if (!partner) {
      return NextResponse.json({ error: "Partner not found" }, { status: 404 })
    }
    return NextResponse.json({ partner })
  } catch (error: unknown) {
    console.error(`[api/airtable/partner/${id}] failed:`, error)
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 })
  }
}
