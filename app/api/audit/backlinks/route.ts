import { NextResponse } from "next/server"
import { z } from "zod"
import {
  DataForSEOError,
  referringDomainsWithSpamScore,
} from "@/lib/dataforseo"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const bodySchema = z.object({
  domain: z.string().min(3),
  limit: z.number().int().min(50).max(1000).optional(),
})

export async function POST(request: Request) {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON" },
      { status: 400 },
    )
  }
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request body", issues: parsed.error.flatten() },
      { status: 400 },
    )
  }

  try {
    const report = await referringDomainsWithSpamScore(parsed.data.domain, {
      limit: parsed.data.limit,
    })
    return NextResponse.json({ report })
  } catch (error) {
    console.error("[api/audit/backlinks] failed:", error)
    const status = error instanceof DataForSEOError ? 502 : 500
    const message = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json({ error: message }, { status })
  }
}
