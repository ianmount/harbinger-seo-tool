import "server-only"
import { NextResponse } from "next/server"
import { z, type ZodTypeAny } from "zod"
import { DataForSEOError, dfsRequest } from "@/lib/dataforseo"

/**
 * Thin helper used by every `app/api/tools/<cat>/<tool>/route.ts`. Parses
 * the request body with the supplied Zod schema, runs the DFSEO call(s),
 * and standardises error responses so the client-side tool pages can
 * always expect `{ rows, meta }` or `{ error }`.
 */

export type ToolMeta = {
  /** DFSEO endpoint(s) actually called. */
  endpoints: readonly string[]
  /** Total DFSEO cost in USD for this run. */
  costUsd?: number
  /** Wall-clock duration in ms. */
  durationMs: number
}

export type ToolSuccess<Row> = {
  rows: Row[]
  meta: ToolMeta
}

export async function runTool<Schema extends ZodTypeAny, Row>(
  request: Request,
  schema: Schema,
  handler: (
    input: z.infer<Schema>,
    ctx: { dfs: typeof dfsRequest },
  ) => Promise<{ rows: Row[]; endpoints: readonly string[]; costUsd?: number }>,
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
      rows: result.rows,
      meta: {
        endpoints: result.endpoints,
        costUsd: result.costUsd,
        durationMs: Date.now() - startedAt,
      },
    } satisfies ToolSuccess<Row>)
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
 * DFSEO envelope shape we depend on, validated leniently. Pass a row
 * schema to validate just the items the tool cares about.
 */
export function extractResults<T>(
  envelope: unknown,
  rowSchema: z.ZodType<T>,
): { rows: T[]; cost: number } {
  const env = z
    .object({
      cost: z.number().optional(),
      tasks: z
        .array(
          z
            .object({
              status_code: z.number(),
              status_message: z.string(),
              cost: z.number().optional(),
              result: z.array(z.unknown()).nullable().optional(),
            })
            .passthrough(),
        )
        .optional()
        .default([]),
    })
    .passthrough()
    .parse(envelope)

  const cost = env.cost ?? 0
  const rows: T[] = []
  for (const task of env.tasks) {
    if (task.status_code >= 40000) {
      throw new DataForSEOError(
        `DFSEO task failed: ${task.status_message}`,
        { dfsStatus: task.status_code },
      )
    }
    if (!task.result) continue
    for (const item of task.result) {
      // Each task.result is typically a single object whose `items` array
      // holds the rows. Flatten conservatively: handle both shapes.
      if (item && typeof item === "object" && "items" in item) {
        const inner = (item as { items?: unknown[] }).items ?? []
        for (const row of inner) {
          const parsed = rowSchema.safeParse(row)
          if (parsed.success) rows.push(parsed.data)
        }
      } else {
        const parsed = rowSchema.safeParse(item)
        if (parsed.success) rows.push(parsed.data)
      }
    }
  }
  return { rows, cost }
}
