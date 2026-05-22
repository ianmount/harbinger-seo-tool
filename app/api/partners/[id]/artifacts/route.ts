import { NextResponse } from "next/server"
import { z } from "zod"
import { deriveSessionId } from "@/lib/jobs"
import { listArtifacts, saveArtifact } from "@/lib/partners"
import type { PartnerArtifactKind } from "@/lib/types"

export const dynamic = "force-dynamic"

const KINDS = [
  "keyword_list",
  "keyword_overview",
  "faq_research",
  "strategy",
  "content_brief",
  "content_copy",
  "backlink_prospects",
  "backlinks_overview",
  "referring_domains",
  "backlink_trends",
  "outreach_drafts",
  "report",
  "technical_crawl",
  "onpage_audit",
  "lighthouse_audit",
  "competitive_analysis",
  "organic_rankings",
  "domain_overview",
  "gbp_heatmap",
  "ai_snapshot",
  "audit",
] as const satisfies ReadonlyArray<PartnerArtifactKind>

const saveSchema = z.object({
  kind: z.enum(KINDS),
  title: z.string().min(1),
  data: z.unknown().optional(),
  blobUrl: z.string().optional(),
  jobId: z.string().uuid().optional(),
})

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return "Unknown error"
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const url = new URL(request.url)
  const kindParam = url.searchParams.get("kind")
  const kind = kindParam && (KINDS as readonly string[]).includes(kindParam)
    ? (kindParam as PartnerArtifactKind)
    : undefined
  const limitParam = url.searchParams.get("limit")
  const limit = limitParam ? Math.max(1, Math.min(500, Number(limitParam))) : undefined

  try {
    const artifacts = await listArtifacts({ partnerId: id, kind, limit })
    return NextResponse.json({ artifacts })
  } catch (error) {
    console.error(`[api/partners/${id}/artifacts] GET failed:`, error)
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 })
  }
}

export async function POST(
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
  const parsed = saveSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.flatten() },
      { status: 400 },
    )
  }
  let sessionId: string | undefined
  try {
    sessionId = await deriveSessionId()
  } catch {
    // Fall through: artifact still saves, just without a session id.
  }
  try {
    const artifact = await saveArtifact({
      partnerId: id,
      kind: parsed.data.kind,
      title: parsed.data.title,
      data: parsed.data.data ?? {},
      blobUrl: parsed.data.blobUrl,
      jobId: parsed.data.jobId,
      sessionId,
    })
    return NextResponse.json({ artifact }, { status: 201 })
  } catch (error) {
    console.error(`[api/partners/${id}/artifacts] POST failed:`, error)
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 })
  }
}
