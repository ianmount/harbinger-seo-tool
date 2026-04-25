import { NextResponse } from "next/server"
import { z } from "zod"
import { GA4Error, getConversionsByPage } from "@/lib/ga4"

export const dynamic = "force-dynamic"

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be ISO format YYYY-MM-DD")

const bodySchema = z
  .object({
    propertyId: z.string().trim().min(1),
    startDate: isoDate,
    endDate: isoDate,
  })
  .refine((v) => v.startDate <= v.endDate, {
    message: "startDate must be on or before endDate",
    path: ["startDate"],
  })

function statusFromGA4Error(error: GA4Error): number {
  switch (error.code) {
    case "NO_REFRESH_TOKEN":
      return 503
    case "INVALID_PROPERTY_ID":
    case "INVALID_DATE_RANGE":
      return 400
    case "FORBIDDEN":
      return 403
    case "NOT_FOUND":
      return 404
    default:
      return error.status ?? 502
  }
}

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
    const results = await getConversionsByPage({ account: "partners", ...parsed.data })
    return NextResponse.json({ results })
  } catch (error: unknown) {
    console.error("[api/ga4/conversions] failed:", error)
    if (error instanceof GA4Error) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: statusFromGA4Error(error) },
      )
    }
    const message = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
