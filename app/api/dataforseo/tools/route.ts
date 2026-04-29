import { NextResponse } from "next/server"
import { z } from "zod"
import { DataForSEOError } from "@/lib/dataforseo"
import {
  ToolValidationError,
  runDfseoTool,
} from "@/lib/dfseo-tools-runner"

export const dynamic = "force-dynamic"
// Some endpoints (LLM responses, ChatGPT scraper, lighthouse) are slow.
export const maxDuration = 300

const bodySchema = z.object({
  toolId: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
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
    const result = await runDfseoTool(parsed.data.toolId, parsed.data.params)
    return NextResponse.json(result)
  } catch (error) {
    console.error("[api/dataforseo/tools] failed:", error)
    if (error instanceof ToolValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    if (error instanceof DataForSEOError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status ?? 502 },
      )
    }
    const msg = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
