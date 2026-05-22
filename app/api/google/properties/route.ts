import { NextResponse } from "next/server"
import { GA4Error, listProperties } from "@/lib/ga4"
import { hasRefreshToken } from "@/lib/google-auth"
import type { GA4PropertyInfo, GoogleAccountSlug } from "@/lib/types"

export const dynamic = "force-dynamic"
export const maxDuration = 60

export interface Ga4PropertyForAccount {
  account: GoogleAccountSlug
  property: GA4PropertyInfo
}

/**
 * Aggregates GA4 properties across both authorized Google accounts. Used
 * by the Onboard Partner form: pick a property from either the partners
 * or assessments account, and the resulting partner record carries the
 * matching `ga4Account` slug.
 *
 * Property enumeration is cached for 10 minutes inside lib/ga4.ts; pass
 * ?refresh=1 to bust both account caches.
 */
export async function GET(request: Request) {
  const accounts: GoogleAccountSlug[] = ["partners", "assessments"]
  const url = new URL(request.url)
  const forceRefresh = url.searchParams.get("refresh") === "1"
  const properties: Ga4PropertyForAccount[] = []
  const errors: { account: GoogleAccountSlug; message: string }[] = []

  await Promise.all(
    accounts.map(async (account) => {
      if (!hasRefreshToken(account)) {
        errors.push({ account, message: "No refresh token configured" })
        return
      }
      try {
        const accountProperties = await listProperties({ account, forceRefresh })
        for (const property of accountProperties) {
          properties.push({ account, property })
        }
      } catch (error) {
        const message =
          error instanceof GA4Error
            ? error.message
            : error instanceof Error
              ? error.message
              : "Unknown GA4 error"
        errors.push({ account, message })
      }
    }),
  )

  properties.sort((a, b) =>
    a.property.displayName.localeCompare(b.property.displayName),
  )
  return NextResponse.json({ properties, errors })
}
