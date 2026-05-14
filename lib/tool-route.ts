import "server-only"
import { NextResponse } from "next/server"
import { z, type ZodTypeAny } from "zod"
import { DataForSEOError, dfsRequest } from "@/lib/dataforseo"

/**
 * Thin helper used by every `app/api/tools/<cat>/<tool>/route.ts`. Parses
 * the request body with the supplied Zod schema, runs the DFSEO call(s),
 * and standardises error responses so the client-side tool pages can
 * always expect `{ data, meta }` or `{ error }`.
 *
 * `data` is whatever shape the tool needs — for simple single-table
 * tools that's `{ rows: Row[] }`; multi-section tools return whatever
 * keyed shape they want and the page renders one `<ResultsTable>` per
 * section.
 */

export type ToolMeta = {
  /** DFSEO endpoint(s) actually called. */
  endpoints: readonly string[]
  /** Total DFSEO cost in USD for this run. */
  costUsd?: number
  /** Wall-clock duration in ms. */
  durationMs: number
}

export type ToolSuccess<TData> = {
  data: TData
  meta: ToolMeta
}

export async function runTool<Schema extends ZodTypeAny, TData>(
  request: Request,
  schema: Schema,
  handler: (
    input: z.infer<Schema>,
    ctx: { dfs: typeof dfsRequest },
  ) => Promise<{
    data: TData
    endpoints: readonly string[]
    costUsd?: number
  }>,
): Promise<NextResponse> {
  const startedAt = Date.now()

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Validation failed",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      { status: 400 },
    )
  }

  try {
    const result = await handler(parsed.data, { dfs: dfsRequest })
    return NextResponse.json({
      data: result.data,
      meta: {
        endpoints: result.endpoints,
        costUsd: result.costUsd,
        durationMs: Date.now() - startedAt,
      },
    } satisfies ToolSuccess<TData>)
  } catch (err) {
    if (err instanceof DataForSEOError) {
      return NextResponse.json(
        {
          error: err.message,
          dfsStatus: err.dfsStatus,
        },
        { status: err.status ?? 502 },
      )
    }
    const message = err instanceof Error ? err.message : "Unknown error"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/**
 * Flatten a DFSEO envelope into the items array embedded at
 * `tasks[*].result[*].items`. Lenient — silently skips tasks whose
 * `result` is null (DFSEO returns null when an individual task within a
 * batch fails, even if the batch itself succeeded).
 */
export function dfsItems<T = unknown>(envelope: unknown): T[] {
  const env = envelope as {
    tasks?: { result?: { items?: unknown[] }[] | null }[]
  }
  const out: T[] = []
  for (const task of env.tasks ?? []) {
    for (const r of task.result ?? []) {
      for (const item of r.items ?? []) {
        out.push(item as T)
      }
    }
  }
  return out
}

/**
 * Flatten a DFSEO envelope where each row lives directly in
 * `tasks[*].result[*]` (no `items` nesting). This is the shape used by
 * Google Ads endpoints — search_volume, ad_traffic_by_keywords — where
 * the `result` array IS the row list, not a wrapper containing one.
 * Using `dfsItems()` on this shape silently yields zero rows.
 */
export function dfsResultItems<T = unknown>(envelope: unknown): T[] {
  const env = envelope as {
    tasks?: { result?: unknown[] | null }[]
  }
  const out: T[] = []
  for (const task of env.tasks ?? []) {
    for (const r of task.result ?? []) {
      if (r != null) out.push(r as T)
    }
  }
  return out
}

/**
 * Sum the per-call `cost` fields across one or more DFSEO envelopes.
 * Use after `Promise.all([...])` to report total run cost in `costUsd`.
 */
export function dfsCost(...envelopes: unknown[]): number {
  let total = 0
  for (const env of envelopes) {
    const c = (env as { cost?: number } | null)?.cost
    if (typeof c === "number") total += c
  }
  return total
}

/** Helper for the common DFSEO Labs location + language field pair. */
export function locationFields(input: {
  location_code?: number
  location_name?: string
  language_code?: string
}): Record<string, string | number> {
  if (input.location_code) {
    return {
      location_code: input.location_code,
      language_code: input.language_code ?? "en",
    }
  }
  return {
    location_name: input.location_name ?? "United States",
    language_name: "English",
  }
}
