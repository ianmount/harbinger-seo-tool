import { NextResponse } from "next/server"
import { env } from "@/lib/env"

export const dynamic = "force-dynamic"

export function GET() {
  const envPresent = {
    anthropic: Boolean(env.ANTHROPIC_API_KEY),
    dataforseo: Boolean(env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD),
    google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    airtable: Boolean(
      env.AIRTABLE_PAT && env.AIRTABLE_BASE_ID && env.AIRTABLE_PARTNERS_TABLE,
    ),
  }
  return NextResponse.json({ ok: true, envPresent })
}
