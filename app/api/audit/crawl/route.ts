import { NextResponse } from "next/server"
import { z } from "zod"
import { crawlSite, CrawlError } from "@/lib/crawler"

export const dynamic = "force-dynamic"
// Crawl can take up to ~60s for 50 pages at 5 concurrent. Request the full
// 300s allowance on Vercel Pro.
export const maxDuration = 300

const bodySchema = z.object({
  domain: z.string().min(3),
  maxPages: z.number().int().min(1).max(50).optional(),
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
    const report = await crawlSite({
      domain: parsed.data.domain,
      options: { maxPages: parsed.data.maxPages },
    })
    return NextResponse.json({ report })
  } catch (error) {
    console.error("[api/audit/crawl] failed:", error)
    const status = error instanceof CrawlError ? 502 : 500
    const message = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json({ error: message }, { status })
  }
}
