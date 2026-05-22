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
 * the Onboard Partner form: pick a site from either the partners or
 * assessments account, and the resulting partner record carries the
 * matching `gscAccount` slug.
 */
export async function GET() {
  const accounts: GoogleAccountSlug[] = ["partners", "assessments"]
  const sites: GscSiteForAccount[] = []
  const errors: { account: GoogleAccountSlug; message: string }[] = []

  await Promise.all(
    accounts.map(async (account) => {
      if (!hasRefreshToken(account)) {
        errors.push({ account, message: "No refresh token configured" })
        return
      }
      try {
        const accountSites = await listSites(account)
        for (const site of accountSites) {
          sites.push({ account, site })
        }
      } catch (error) {
        const message =
          error instanceof GSCError
            ? error.message
            : error instanceof Error
              ? error.message
              : "Unknown GSC error"
        errors.push({ account, message })
      }
    }),
  )

  sites.sort((a, b) => a.site.siteUrl.localeCompare(b.site.siteUrl))
  return NextResponse.json({ sites, errors })
}
