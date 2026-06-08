import { deriveSessionId } from "@/lib/jobs"
import { getRunForSession } from "@/lib/keyword-research-runs"
import { buildLocationCsv, locationCsvFilename } from "@/lib/keyword-research/csv"

/**
 * GET /api/keywords/research/runs/[id]/csv?location=<slug>
 * Streams the per-location CSV (the deliverable). Scoped to the session.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params
  if (!id) {
    return Response.json({ error: "missing_id" }, { status: 400 })
  }
  const slug = new URL(request.url).searchParams.get("location")
  if (!slug) {
    return Response.json({ error: "missing_location" }, { status: 400 })
  }

  const sessionId = await deriveSessionId()
  const run = await getRunForSession(id, sessionId)
  if (!run || !run.result) {
    return Response.json({ error: "not_found" }, { status: 404 })
  }

  const loc = run.result.locations.find((l) => l.slug === slug)
  if (!loc) {
    return Response.json({ error: "location_not_found" }, { status: 404 })
  }

  const csv = buildLocationCsv(loc)
  const filename = locationCsvFilename(run.domain, slug)
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  })
}
