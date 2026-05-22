import { NextResponse } from "next/server"
import { z } from "zod"
import { deletePartner, getPartner, updatePartner } from "@/lib/partners"

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

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  website: z.string().min(1).optional(),
  services: z.string().optional(),
  serviceAreas: z.string().optional(),
  partnerGoals: z.string().optional(),
  targetAudience: z.string().optional(),
  contentMarketing: z.string().optional(),
  industryKnowledge: z.string().optional(),
  // Preferred (multi):
  gscSites: z.array(gscSiteRef).optional(),
  ga4Properties: z.array(ga4PropertyRef).optional(),
  // Legacy singulars — accepted but array form wins when both supplied.
  gscSiteUrl: z.string().optional(),
  gscAccount: accountSlug.optional(),
  ga4PropertyId: z.string().optional(),
  ga4Account: accountSlug.optional(),
})

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return "Unknown error"
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
  } catch (error) {
    console.error(`[api/partners/${id}] GET failed:`, error)
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 })
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.flatten() },
      { status: 400 },
    )
  }
  try {
    const partner = await updatePartner(id, parsed.data)
    return NextResponse.json({ partner })
  } catch (error) {
    console.error(`[api/partners/${id}] PATCH failed:`, error)
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 })
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  try {
    await deletePartner(id)
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error(`[api/partners/${id}] DELETE failed:`, error)
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 })
  }
}
