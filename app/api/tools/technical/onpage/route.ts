import { z } from "zod"
import { NextResponse } from "next/server"
import {
  OnPageError,
  fetchDuplicateTags,
  fetchLighthouseLive,
  fetchLinks,
  fetchMicrodata,
  fetchNonIndexable,
  fetchRedirectChains,
  fetchSummary,
  runOnPageCrawl,
} from "@/lib/dataforseo-onpage"
import { buildAuditReport, type AuditReport } from "@/lib/onpage-audit"
import { discoverSitemap } from "@/lib/sitemap"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const Input = z.object({
  target: z.string().min(3),
  max_crawl_pages: z.number().int().min(1).max(200),
  enable_javascript: z.boolean().default(false),
  run_lighthouse: z.boolean().default(true),
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
    const crawl = await runOnPageCrawl({
      domain: parsed.data.target,
      maxPages: parsed.data.max_crawl_pages,
      enableJavaScript: parsed.data.enable_javascript,
    })
    const taskId = crawl.taskId

    // After the crawl finishes, hit every audit-tab endpoint in parallel.
    // Each fetcher swallows its own task-level errors and returns [].
    const homepage = crawl.pages[0]?.finalUrl ?? crawl.pages[0]?.url ?? null

    const [
      summary,
      rawLinks,
      rawDupTitles,
      rawDupDescs,
      rawMicrodata,
      rawRedirectChains,
      rawNonIndexable,
      sitemapProbe,
      lighthouse,
    ] = await Promise.all([
      fetchSummary(taskId).catch(() => null),
      fetchLinks(taskId).catch(() => []),
      fetchDuplicateTags(taskId, "title").catch(() => []),
      fetchDuplicateTags(taskId, "description").catch(() => []),
      fetchMicrodata(taskId).catch(() => []),
      fetchRedirectChains(taskId).catch(() => []),
      fetchNonIndexable(taskId).catch(() => []),
      probeSitemap(parsed.data.target),
      parsed.data.run_lighthouse && homepage
        ? fetchLighthouseLive(homepage)
        : Promise.resolve(null),
    ])

    const report = buildAuditReport({
      pages: crawl.pages,
      rawLinks,
      rawDupTitles,
      rawDupDescs,
      rawNonIndexable,
      rawRedirectChains,
      rawMicrodata,
      summary,
      sitemapMissing: sitemapProbe.missing,
      lighthouse,
      jsRendered: crawl.enabledJavaScript,
    })

    const endpoints = [
      "/v3/on_page/task_post",
      "/v3/on_page/summary",
      "/v3/on_page/pages",
      "/v3/on_page/links",
      "/v3/on_page/duplicate_tags",
      "/v3/on_page/microdata",
      "/v3/on_page/redirect_chains",
      "/v3/on_page/non_indexable",
      ...(lighthouse ? ["/v3/on_page/lighthouse/live/json"] : []),
    ]

    return NextResponse.json({
      data: report satisfies AuditReport,
      meta: {
        endpoints,
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

async function probeSitemap(
  target: string,
): Promise<{ missing: boolean }> {
  try {
    const result = await discoverSitemap(target)
    // Treat "no sitemap URLs discovered" as missing — covers both no
    // robots.txt advertisement and 404s on the conventional fallbacks.
    return { missing: result.sitemapUrls.length === 0 }
  } catch {
    return { missing: true }
  }
}
