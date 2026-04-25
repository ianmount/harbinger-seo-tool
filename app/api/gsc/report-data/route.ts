import { NextResponse } from "next/server"
import { z } from "zod"
import {
  getDailyClicks,
  getTopPages,
  getTopQueries,
  GSCError,
} from "@/lib/gsc"

export const dynamic = "force-dynamic"

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be ISO format YYYY-MM-DD")

const bodySchema = z
  .object({
    siteUrl: z.string().trim().min(1),
    startDate: isoDate,
    endDate: isoDate,
    rowLimit: z.number().int().positive().max(1000).optional(),
  })
  .refine((v) => v.startDate <= v.endDate, {
    message: "startDate must be on or before endDate",
    path: ["startDate"],
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
  const { siteUrl, startDate, endDate, rowLimit } = parsed.data

  try {
    const [topQueries, topPages, dailyClicks] = await Promise.all([
      getTopQueries({ account: "partners", siteUrl, startDate, endDate, rowLimit: rowLimit ?? 100 }),
      getTopPages({ account: "partners", siteUrl, startDate, endDate, rowLimit: rowLimit ?? 100 }),
      getDailyClicks({ account: "partners", siteUrl, startDate, endDate }),
    ])
    return NextResponse.json({ topQueries, topPages, dailyClicks })
  } catch (error: unknown) {
    console.error("[api/gsc/report-data] failed:", error)
    if (error instanceof GSCError) {
      const status =
        error.code === "NO_REFRESH_TOKEN" ? 503 : error.status ?? 502
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status },
      )
    }
    const message = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
