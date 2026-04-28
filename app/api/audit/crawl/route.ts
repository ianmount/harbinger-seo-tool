import { NextResponse } from "next/server"
import { z } from "zod"
import { crawlSite, CrawlError } from "@/lib/crawler"

export const dynamic = "force-dynamic"
// Crawl can take several minutes on large sitemaps in full mode. Request
// the 800s allowance available on Vercel Pro with Fluid Compute enabled.
export const maxDuration = 800

const bodySchema = z.object({
  domain: z.string().min(3),
  /**
   * `"full"` (default) — crawl every URL the sitemap reports, subject to the
   * crawler's safety ceiling. `"sample"` caps at 50 prioritized URLs and is
   * intended for fast iteration during development.
   */
  crawlMode: z.enum(["full", "sample"]).optional(),
  /** Override the default ceiling for the chosen mode. Capped at 50 in sample. */
  maxPages: z.number().int().min(1).max(2000).optional(),
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
      options: {
        mode: parsed.data.crawlMode ?? "full",
        maxPages: parsed.data.maxPages,
      },
    })
    return NextResponse.json({ report })
  } catch (error) {
    console.error("[api/audit/crawl] failed:", error)
    const status = error instanceof CrawlError ? 502 : 500
    const message = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json({ error: message }, { status })
  }
}
