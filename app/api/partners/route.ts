import { NextResponse } from "next/server"
import { z } from "zod"
import { createPartner, getPartners } from "@/lib/partners"

export const dynamic = "force-dynamic"

const accountSlug = z.enum(["partners", "assessments"])

const gscSiteRef = z.object({
  siteUrl: z.string().min(1),
  account: accountSlug,
})

const ga4PropertyRef = z.object({
  propertyId: z.string().min(1),
  account: accountSlug,
})

const createSchema = z.object({
  name: z.string().min(1),
  website: z.string().min(1),
  services: z.string().optional(),
  serviceAreas: z.string().optional(),
  partnerGoals: z.string().optional(),
  targetAudience: z.string().optional(),
  contentMarketing: z.string().optional(),
  industryKnowledge: z.string().optional(),
  // Preferred (multi):
  gscSites: z.array(gscSiteRef).optional(),
  ga4Properties: z.array(ga4PropertyRef).optional(),
  // Legacy singular fields — still accepted; the array form wins if both
  // are supplied because lib/partners.buildIntegrationsPayload prefers it.
  gscSiteUrl: z.string().optional(),
  gscAccount: accountSlug.optional(),
  ga4PropertyId: z.string().optional(),
  ga4Account: accountSlug.optional(),
})

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return "Unknown error"
}

export async function GET() {
  try {
    const partners = await getPartners()
    return NextResponse.json({ partners })
  } catch (error) {
    console.error("[api/partners] GET failed:", error)
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 })
  }
}

export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.flatten() },
      { status: 400 },
    )
  }
  try {
    const partner = await createPartner(parsed.data)
    return NextResponse.json({ partner }, { status: 201 })
  } catch (error) {
    console.error("[api/partners] POST failed:", error)
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 })
  }
}
