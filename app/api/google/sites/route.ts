import { NextResponse } from "next/server"
import { hasRefreshToken } from "@/lib/google-auth"
import { listSites, GSCError } from "@/lib/gsc"
import type { GoogleAccountSlug, GSCSiteInfo } from "@/lib/types"

export const dynamic = "force-dynamic"
export const maxDuration = 60

export interface GscSiteForAccount {
  account: GoogleAccountSlug
  site: GSCSiteInfo
}

/**
 * Aggregates GSC sites across both authorized Google accounts. Used by
 * the Onboard Partner form: pick one or more sites from either the
 * partners or assessments account, and the resulting partner record
 * carries the matching `gscAccount` slug per selection.
 */
export async function GET() {
  const accounts: GoogleAccountSlug[] = ["partners", "assessments"]
  const sites: GscSiteForAccount[] = []
  const errors: { account: GoogleAccountSlug; message: string }[] = []
  const summary: Record<
    GoogleAccountSlug,
    { ok: boolean; count: number; error?: string }
  > = {
    partners: { ok: false, count: 0 },
    assessments: { ok: false, count: 0 },
  }

  await Promise.all(
    accounts.map(async (account) => {
      if (!hasRefreshToken(account)) {
        const message = `${account}: no refresh token configured (set GOOGLE_REFRESH_TOKEN_${account.toUpperCase()})`
        errors.push({ account, message })
        summary[account].error = "no refresh token"
        return
      }
      try {
        const accountSites = await listSites(account)
        for (const site of accountSites) {
          sites.push({ account, site })
        }
        summary[account] = { ok: true, count: accountSites.length }
      } catch (error) {
        const message =
          error instanceof GSCError
            ? error.message
            : error instanceof Error
              ? error.message
              : "Unknown GSC error"
        errors.push({ account, message })
        summary[account].error = message
      }
    }),
  )

  sites.sort((a, b) => a.site.siteUrl.localeCompare(b.site.siteUrl))

  console.log(
    `[api/google/sites] partners=${summary.partners.count}${summary.partners.error ? ` (err: ${summary.partners.error})` : ""}, assessments=${summary.assessments.count}${summary.assessments.error ? ` (err: ${summary.assessments.error})` : ""}`,
  )

  return NextResponse.json({ sites, errors, summary })
}
