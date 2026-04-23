import { NextResponse } from "next/server"
import { generateAuthUrl } from "@/lib/gsc"

export const dynamic = "force-dynamic"

export function GET() {
  const url = generateAuthUrl()
  return NextResponse.redirect(url)
}
