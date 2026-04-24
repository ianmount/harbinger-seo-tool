import { NextResponse } from "next/server"
import { env } from "@/lib/env"
import { GSC_SCOPES } from "@/lib/gsc"

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
  // `oauthScopes` surfaces the scope list the OAuth flow will request so we
  // can verify a deploy without running through Google's consent screen.
  return NextResponse.json({
    ok: true,
    envPresent,
    oauthScopes: [...GSC_SCOPES],
  })
}
