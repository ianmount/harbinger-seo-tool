import { NextResponse } from "next/server"
import { z } from "zod"
import {
  createCostAccumulator,
  totalCostUsd,
  withAuditCost,
} from "@/lib/audit-cost"
import { generateAltTags } from "@/lib/alt-tags"

export const dynamic = "force-dynamic"
// Same 800s ceiling as the audit pipeline — large sites with many images
// can spend most of the budget on Claude calls.
export const maxDuration = 800

const bodySchema = z.object({
  domain: z.string().min(3),
  maxPages: z.number().int().min(1).max(1000).optional(),
  skipImagesWithAlt: z.boolean().optional(),
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

  const cost = createCostAccumulator()
  try {
    const result = await withAuditCost(cost, () =>
      generateAltTags({
        domain: parsed.data.domain,
        maxPages: parsed.data.maxPages,
        skipImagesWithAlt: parsed.data.skipImagesWithAlt,
      }),
    )
    const costUsd = totalCostUsd(cost)
    console.log(
      `[api/tools/alt-tags] domain=${parsed.data.domain} pages=${result.pagesCrawled} images=${result.imagesFound} processed=${result.imagesProcessed} cost=$${costUsd.toFixed(4)} duration=${result.durationMs}ms`,
    )
    return NextResponse.json({
      rows: result.rows,
      pagesCrawled: result.pagesCrawled,
      pagesWithImages: result.pagesWithImages,
      imagesFound: result.imagesFound,
      imagesProcessed: result.imagesProcessed,
      durationMs: result.durationMs,
      costUsd,
      dataforseoUsd: cost.dataforseoUsd,
      claudeUsd: cost.claudeUsd,
    })
  } catch (error) {
    console.error("[api/tools/alt-tags] failed:", error)
    const message = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
