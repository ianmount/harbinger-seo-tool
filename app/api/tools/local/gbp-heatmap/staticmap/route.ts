import { NextResponse } from "next/server"

/**
 * Server-side proxy for a Google Static Maps base image, used by the heatmap
 * PDF export. We proxy (rather than letting the browser/@react-pdf fetch
 * Google directly) because the Static Maps API doesn't send CORS headers, so a
 * browser fetch of the image bytes is blocked. A same-origin call to this route
 * (which carries the auth cookie and is gated by the proxy) sidesteps that.
 *
 * Key: prefers a dedicated server key (GOOGLE_STATIC_MAPS_KEY) and falls back to
 * the public Maps JS key. Note: if that key is HTTP-referrer-restricted it will
 * reject this server request (no referer) — in that case set an unrestricted /
 * IP-restricted GOOGLE_STATIC_MAPS_KEY, and ensure the Static Maps API is
 * enabled. On any failure we 502 so the PDF builder falls back to the plain
 * vector snapshot.
 */
export const dynamic = "force-dynamic"
export const maxDuration = 30

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url)
  const lat = Number(searchParams.get("center_lat"))
  const lng = Number(searchParams.get("center_lng"))
  const zoom = Number(searchParams.get("zoom"))
  const w = Math.min(640, Math.max(64, Math.round(Number(searchParams.get("w")))))
  const h = Math.min(640, Math.max(64, Math.round(Number(searchParams.get("h")))))

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    !Number.isFinite(zoom) ||
    !Number.isFinite(w) ||
    !Number.isFinite(h)
  ) {
    return NextResponse.json({ error: "invalid params" }, { status: 400 })
  }

  const key =
    process.env.GOOGLE_STATIC_MAPS_KEY ??
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
  if (!key) {
    return NextResponse.json({ error: "no maps key" }, { status: 400 })
  }

  const z = Math.min(21, Math.max(0, Math.round(zoom)))
  const url =
    `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}` +
    `&zoom=${z}&size=${w}x${h}&scale=2&maptype=roadmap&key=${key}`

  let resp: Response
  try {
    resp = await fetch(url)
  } catch (err) {
    return NextResponse.json(
      { error: `fetch failed: ${err instanceof Error ? err.message : "unknown"}` },
      { status: 502 },
    )
  }

  const contentType = resp.headers.get("content-type") ?? ""
  if (!resp.ok || !contentType.startsWith("image")) {
    const detail = await resp.text().catch(() => "")
    console.error(`[staticmap] ${resp.status} ${contentType} ${detail.slice(0, 200)}`)
    return NextResponse.json(
      { error: `static maps ${resp.status}`, detail: detail.slice(0, 200) },
      { status: 502 },
    )
  }

  const buf = await resp.arrayBuffer()
  return new NextResponse(buf, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=600",
    },
  })
}
