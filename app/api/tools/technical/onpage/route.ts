import { z } from "zod"
import { NextResponse } from "next/server"
import { dfsRequest } from "@/lib/dataforseo"
import { runOnPageCrawl, OnPageError } from "@/lib/dataforseo-onpage"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const Input = z.object({
  target: z.string().min(3),
  max_crawl_pages: z.number().int().min(1).max(200),
  enable_javascript: z.boolean().default(false),
})

type PageRow = {
  url: string
  status_code: number | null
  title: string | null
  meta_description_length: number | null
  word_count: number | null
  internal_links: number | null
  has_h1: boolean
}

type ResourceRow = {
  url: string
  resource_type: string | null
  status_code: number | null
  size: number | null
  fetch_time_ms: number | null
}

type LinkRow = {
  source: string
  target: string
  link_type: string | null
  direction: string | null
  status_code: number | null
}

type DuplicateRow = {
  field: string
  value: string
  affected_pages: number
  sample_url: string | null
}

type Data = {
  pages: PageRow[]
  resources: ResourceRow[]
  links: LinkRow[]
  duplicates: DuplicateRow[]
}

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

    // After the crawl finishes, the same task_id unlocks the rest of the
    // On-Page API surface. Pull resources, links, and duplicate-tags in
    // parallel; each is a POST with `{ id: taskId, limit }`.
    const [resourcesEnv, linksEnv, dupTitleEnv, dupDescEnv] = await Promise.all(
      [
        dfsRequest("/v3/on_page/resources", [
          { id: taskId, limit: 1000 },
        ]).catch(() => null),
        dfsRequest("/v3/on_page/links", [
          { id: taskId, limit: 1000 },
        ]).catch(() => null),
        dfsRequest("/v3/on_page/duplicate_tags", [
          { id: taskId, tag: "title", limit: 100 },
        ]).catch(() => null),
        dfsRequest("/v3/on_page/duplicate_tags", [
          { id: taskId, tag: "description", limit: 100 },
        ]).catch(() => null),
      ],
    )

    const pages: PageRow[] = crawl.pages.map((p) => ({
      url: p.url,
      status_code: p.statusCode,
      title: p.title,
      meta_description_length: p.description?.length ?? null,
      word_count: p.wordCount,
      internal_links: p.internalLinksCount,
      has_h1: p.h1s.length > 0,
    }))

    const resources: ResourceRow[] = []
    const rTasks = (resourcesEnv as
      | {
          tasks?: { result?: { items?: unknown[] }[] }[]
        }
      | null)?.tasks
    for (const t of rTasks ?? []) {
      for (const r of t.result ?? []) {
        for (const raw of r.items ?? []) {
          const it = raw as {
            url?: string
            resource_type?: string | null
            status_code?: number | null
            size?: number | null
            fetch_time?: number | null
          }
          resources.push({
            url: it.url ?? "",
            resource_type: it.resource_type ?? null,
            status_code: it.status_code ?? null,
            size: it.size ?? null,
            fetch_time_ms: it.fetch_time ?? null,
          })
        }
      }
    }

    const links: LinkRow[] = []
    const lTasks = (linksEnv as
      | { tasks?: { result?: { items?: unknown[] }[] }[] }
      | null)?.tasks
    for (const t of lTasks ?? []) {
      for (const r of t.result ?? []) {
        for (const raw of r.items ?? []) {
          const it = raw as {
            page_from?: string
            link_from?: string
            page_to?: string
            link_to?: string
            link_type?: string | null
            type?: string | null
            direction?: string | null
            status_code?: number | null
          }
          links.push({
            source: it.page_from ?? it.link_from ?? "",
            target: it.page_to ?? it.link_to ?? "",
            link_type: it.link_type ?? it.type ?? null,
            direction: it.direction ?? null,
            status_code: it.status_code ?? null,
          })
        }
      }
    }

    const duplicates: DuplicateRow[] = []
    for (const [field, env] of [
      ["title", dupTitleEnv] as const,
      ["description", dupDescEnv] as const,
    ]) {
      const tasks = (env as
        | { tasks?: { result?: { items?: unknown[] }[] }[] }
        | null)?.tasks
      for (const t of tasks ?? []) {
        for (const r of t.result ?? []) {
          for (const raw of r.items ?? []) {
            const it = raw as {
              value?: string
              total_count?: number
              pages?: { url?: string }[]
            }
            duplicates.push({
              field,
              value: it.value ?? "",
              affected_pages: it.total_count ?? it.pages?.length ?? 0,
              sample_url: it.pages?.[0]?.url ?? null,
            })
          }
        }
      }
    }

    return NextResponse.json({
      data: {
        pages,
        resources,
        links,
        duplicates,
      } satisfies Data,
      meta: {
        endpoints: [
          "/v3/on_page/task_post",
          "/v3/on_page/summary",
          "/v3/on_page/pages",
          ...(resourcesEnv ? ["/v3/on_page/resources"] : []),
          ...(linksEnv ? ["/v3/on_page/links"] : []),
          ...(dupTitleEnv || dupDescEnv ? ["/v3/on_page/duplicate_tags"] : []),
        ],
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
