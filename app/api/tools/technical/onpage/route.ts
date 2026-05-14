import { z } from "zod"
import { NextResponse } from "next/server"
import { runOnPageCrawl, OnPageError } from "@/lib/dataforseo-onpage"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const Input = z.object({
  target: z.string().min(3),
  max_crawl_pages: z.number().int().min(1).max(200),
  enable_javascript: z.boolean().default(false),
})

export async function POST(request: Request) {
  const startedAt = Date.now()
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const parsed = Input.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    )
  }

  try {
    const result = await runOnPageCrawl({
      domain: parsed.data.target,
      maxPages: parsed.data.max_crawl_pages,
      enableJavaScript: parsed.data.enable_javascript,
    })
    const rows = result.pages.map((p) => ({
      url: p.url,
      status_code: p.statusCode,
      title: p.title,
      meta_description_length: p.description?.length ?? null,
      word_count: p.wordCount,
      internal_links: p.internalLinksCount,
      external_links: null,
      has_h1: p.h1s.length > 0,
    }))
    return NextResponse.json({
      rows,
      meta: {
        endpoints: ["/v3/on_page/task_post", "/v3/on_page/summary", "/v3/on_page/pages"],
        durationMs: Date.now() - startedAt,
      },
    })
  } catch (err) {
    const message =
      err instanceof OnPageError
        ? err.message
        : err instanceof Error
          ? err.message
          : "Crawl failed"
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
