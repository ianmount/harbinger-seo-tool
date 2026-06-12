import {
  Circle,
  Document,
  Image,
  Line,
  Page,
  pdf,
  Rect,
  StyleSheet,
  Svg,
  Text,
  View,
} from "@react-pdf/renderer"
import React from "react"
import { positionBuckets, rankColor } from "@/lib/gbp-heatmap"

/**
 * Client-side GBP Heatmap PDF.
 *
 * Each selected business (target + chosen competitors) gets a page with a
 * geographic "snapshot" — the scanned vantage points colored by rank — drawn
 * over a real Google street map. The base map is a Static Maps image fetched
 * via our server proxy (the browser can't read Google's image bytes directly
 * because Static Maps sends no CORS headers); the rank dots are overlaid as a
 * native @react-pdf SVG, projected with the same Web-Mercator math the Static
 * Maps API uses so they line up with the streets. If the base map can't be
 * fetched (key restricted / Static Maps API off), we fall back to a plain
 * vector snapshot so the export still works.
 */

export interface HeatmapPdfEntity {
  title: string
  kind: "target" | "competitor"
  rating: number | null
  ratingCount: number | null
  address: string | null
  /** Parallel to `points` — the rank at each vantage point for this business. */
  ranks: (number | null)[]
  markerLat: number | null
  markerLng: number | null
}

export interface HeatmapPdfData {
  business: string
  keyword: string
  areaLabel: string
  generatedAt: string
  points: { lat: number; lng: number }[]
  target: HeatmapPdfEntity
  competitors: HeatmapPdfEntity[]
}

const C = {
  navy: "#0F2744",
  ink: "#1A1A1A",
  muted: "#6B7280",
  hairline: "#E5E7EB",
  paper: "#F5F4ED",
  brandRed: "#FF1E00",
} as const

const styles = StyleSheet.create({
  page: { padding: 36, fontFamily: "Helvetica", color: C.ink },
  eyebrow: {
    fontSize: 8,
    letterSpacing: 1.5,
    color: C.muted,
    fontFamily: "Helvetica-Bold",
    textTransform: "uppercase",
  },
  business: { fontSize: 18, fontFamily: "Helvetica-Bold", color: C.navy, marginTop: 4 },
  keywordRow: {
    marginTop: 8,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: C.navy,
    borderRadius: 4,
    paddingVertical: 6,
    paddingHorizontal: 10,
    alignSelf: "flex-start",
  },
  keywordLabel: {
    fontSize: 8,
    color: "#9DB2C9",
    fontFamily: "Helvetica-Bold",
    letterSpacing: 1,
    marginRight: 6,
  },
  keyword: { fontSize: 13, color: "#FFFFFF", fontFamily: "Helvetica-Bold" },
  meta: { fontSize: 8.5, color: C.muted, marginTop: 6 },
  entityHeader: {
    marginTop: 16,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    borderBottomWidth: 1,
    borderBottomColor: C.hairline,
    paddingBottom: 6,
  },
  entityTitle: { fontSize: 13, fontFamily: "Helvetica-Bold", color: C.ink },
  badge: { fontSize: 7.5, color: C.muted, fontFamily: "Helvetica-Bold", marginTop: 2 },
  rating: { fontSize: 9, color: C.muted },
  snapshot: { marginTop: 12, position: "relative" },
  snapshotImg: { position: "absolute", top: 0, left: 0, borderRadius: 6 },
  snapshotSvg: { position: "absolute", top: 0, left: 0 },
  kpis: { flexDirection: "row", gap: 8, marginTop: 12 },
  kpiCard: {
    flex: 1,
    borderWidth: 1,
    borderColor: C.hairline,
    borderRadius: 4,
    padding: 8,
  },
  kpiLabel: { fontSize: 7.5, color: C.muted, fontFamily: "Helvetica-Bold" },
  kpiValue: { fontSize: 17, fontFamily: "Helvetica-Bold", marginTop: 3 },
  kpiSub: { fontSize: 7.5, color: C.muted, marginTop: 1 },
  summaryRow: { flexDirection: "row", gap: 16, marginTop: 10 },
  summaryItem: { fontSize: 9, color: C.ink },
  summaryStrong: { fontFamily: "Helvetica-Bold" },
  legend: { flexDirection: "row", gap: 12, marginTop: 8, flexWrap: "wrap" },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 3 },
  legendText: { fontSize: 7.5, color: C.muted },
  footer: {
    position: "absolute",
    bottom: 20,
    left: 36,
    right: 36,
    fontSize: 7.5,
    color: C.muted,
    flexDirection: "row",
    justifyContent: "space-between",
  },
})

const SNAP_W = 523
const SNAP_H = 300
const PAD = 30
const TILE = 256

// ── Web-Mercator (matches Google Static Maps projection) ─────────────────────

function lngToWorldX(lng: number): number {
  return ((lng + 180) / 360) * TILE
}
function latToWorldY(lat: number): number {
  const s = Math.min(Math.max(Math.sin((lat * Math.PI) / 180), -0.9999), 0.9999)
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE
}
function worldYToLat(y: number): number {
  const a = (0.5 - y / TILE) * 4 * Math.PI
  const e = Math.exp(a)
  return (Math.asin((e - 1) / (e + 1)) * 180) / Math.PI
}

interface ViewParams {
  centerLat: number
  centerLng: number
  zoom: number
}

/** Center + zoom that fits all points inside a w×h box with padding. */
function fitView(
  points: { lat: number; lng: number }[],
  w: number,
  h: number,
  pad: number,
): ViewParams {
  const xs = points.map((p) => lngToWorldX(p.lng))
  const ys = points.map((p) => latToWorldY(p.lat))
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const dx = maxX - minX || 1e-6
  const dy = maxY - minY || 1e-6
  const zoom = Math.max(
    0,
    Math.min(
      20,
      Math.floor(
        Math.min(Math.log2((w - 2 * pad) / dx), Math.log2((h - 2 * pad) / dy)),
      ),
    ),
  )
  const cWorldX = (minX + maxX) / 2
  const cWorldY = (minY + maxY) / 2
  return {
    centerLat: worldYToLat(cWorldY),
    centerLng: (cWorldX / TILE) * 360 - 180,
    zoom,
  }
}

function projectPoint(
  lat: number,
  lng: number,
  view: ViewParams,
  w: number,
  h: number,
): { x: number; y: number } {
  const scale = 2 ** view.zoom
  const cwx = lngToWorldX(view.centerLng) * scale
  const cwy = latToWorldY(view.centerLat) * scale
  return {
    x: w / 2 + (lngToWorldX(lng) * scale - cwx),
    y: h / 2 + (latToWorldY(lat) * scale - cwy),
  }
}

function avgRank(ranks: (number | null)[]): number | null {
  const nums = ranks.filter((r): r is number => typeof r === "number")
  if (nums.length === 0) return null
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

async function fetchBaseMap(view: ViewParams): Promise<string | null> {
  try {
    const res = await fetch(
      `/api/tools/local/gbp-heatmap/staticmap?center_lat=${view.centerLat}` +
        `&center_lng=${view.centerLng}&zoom=${view.zoom}&w=${SNAP_W}&h=${SNAP_H}`,
    )
    if (!res.ok) return null
    const blob = await res.blob()
    return await new Promise<string | null>((resolve) => {
      const fr = new FileReader()
      fr.onload = () => resolve(typeof fr.result === "string" ? fr.result : null)
      fr.onerror = () => resolve(null)
      fr.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

// ── Document ─────────────────────────────────────────────────────────────────

function Snapshot({
  xy,
  ranks,
  markerXY,
  baseMap,
}: {
  xy: { x: number; y: number }[]
  ranks: (number | null)[]
  markerXY: { x: number; y: number } | null
  baseMap: string | null
}) {
  const showNumbers = xy.length <= 80
  const r = xy.length > 90 ? 5 : xy.length > 49 ? 7 : 9
  const inBox = (p: { x: number; y: number }) =>
    p.x >= -10 && p.x <= SNAP_W + 10 && p.y >= -10 && p.y <= SNAP_H + 10
  return (
    <View style={[styles.snapshot, { width: SNAP_W, height: SNAP_H }]}>
      {baseMap ? (
        // eslint-disable-next-line jsx-a11y/alt-text -- @react-pdf Image, not HTML img
        <Image
          src={baseMap}
          style={[styles.snapshotImg, { width: SNAP_W, height: SNAP_H }]}
        />
      ) : null}
      <Svg width={SNAP_W} height={SNAP_H} style={styles.snapshotSvg}>
        {!baseMap ? (
          <>
            <Rect
              x={0}
              y={0}
              width={SNAP_W}
              height={SNAP_H}
              rx={6}
              fill={C.paper}
              stroke={C.hairline}
            />
            {[0.25, 0.5, 0.75].map((f) => (
              <Line
                key={`v${f}`}
                x1={f * SNAP_W}
                y1={0}
                x2={f * SNAP_W}
                y2={SNAP_H}
                stroke="#E8E6DB"
              />
            ))}
            {[0.25, 0.5, 0.75].map((f) => (
              <Line
                key={`h${f}`}
                x1={0}
                y1={f * SNAP_H}
                x2={SNAP_W}
                y2={f * SNAP_H}
                stroke="#E8E6DB"
              />
            ))}
          </>
        ) : (
          <Rect
            x={0}
            y={0}
            width={SNAP_W}
            height={SNAP_H}
            rx={6}
            fill="transparent"
            stroke={C.hairline}
          />
        )}
        {xy.map((p, i) => {
          if (!inBox(p)) return null
          const rank = ranks[i] ?? null
          return (
            <React.Fragment key={i}>
              <Circle
                cx={p.x}
                cy={p.y}
                r={r}
                fill={rankColor(rank)}
                stroke="#FFFFFF"
                strokeWidth={1.25}
              />
              {showNumbers ? (
                <Text
                  x={p.x}
                  y={p.y + 2.5}
                  style={{ fontSize: 6.5, fontFamily: "Helvetica-Bold" }}
                  fill="#FFFFFF"
                  textAnchor="middle"
                >
                  {rank == null ? "—" : String(rank)}
                </Text>
              ) : null}
            </React.Fragment>
          )
        })}
        {markerXY && inBox(markerXY) ? (
          <Circle
            cx={markerXY.x}
            cy={markerXY.y}
            r={5}
            fill={C.brandRed}
            stroke="#FFFFFF"
            strokeWidth={2}
          />
        ) : null}
      </Svg>
    </View>
  )
}

function Buckets({ ranks }: { ranks: (number | null)[] }) {
  return (
    <View style={styles.kpis}>
      {positionBuckets(ranks).map((b) => (
        <View key={b.label} style={styles.kpiCard}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Svg width={8} height={8}>
              <Circle cx={4} cy={4} r={4} fill={b.color} />
            </Svg>
            <Text style={styles.kpiLabel}>{b.label}</Text>
          </View>
          <Text style={styles.kpiValue}>{b.count}</Text>
          <Text style={styles.kpiSub}>
            {b.count === 1 ? "point" : "points"} · {b.pct.toFixed(0)}% of grid
          </Text>
        </View>
      ))}
    </View>
  )
}

function EntityPage({
  data,
  entity,
  xy,
  view,
  baseMap,
}: {
  data: HeatmapPdfData
  entity: HeatmapPdfEntity
  xy: { x: number; y: number }[]
  view: ViewParams
  baseMap: string | null
}) {
  const ar = avgRank(entity.ranks)
  const found = entity.ranks.filter((r) => typeof r === "number").length
  const sov = positionBuckets(entity.ranks)[0]
  const markerXY =
    entity.markerLat != null && entity.markerLng != null
      ? projectPoint(entity.markerLat, entity.markerLng, view, SNAP_W, SNAP_H)
      : null
  return (
    <Page size="A4" style={styles.page}>
      <Text style={styles.eyebrow}>GBP Geo-Grid Heatmap</Text>
      <Text style={styles.business}>{data.business}</Text>
      <View style={styles.keywordRow}>
        <Text style={styles.keywordLabel}>KEYWORD</Text>
        <Text style={styles.keyword}>{data.keyword || "—"}</Text>
      </View>
      <Text style={styles.meta}>
        {data.areaLabel} · Generated {data.generatedAt}
      </Text>

      <View style={styles.entityHeader}>
        <View>
          <Text style={styles.entityTitle}>{entity.title}</Text>
          <Text style={styles.badge}>
            {entity.kind === "target" ? "TARGET BUSINESS" : "COMPETITOR"}
            {entity.address ? ` · ${entity.address}` : ""}
          </Text>
        </View>
        <Text style={styles.rating}>
          {entity.rating != null
            ? `★ ${entity.rating.toFixed(1)}${
                entity.ratingCount != null ? ` (${entity.ratingCount})` : ""
              }`
            : ""}
        </Text>
      </View>

      <Snapshot xy={xy} ranks={entity.ranks} markerXY={markerXY} baseMap={baseMap} />

      <View style={styles.legend}>
        {positionBuckets(entity.ranks).map((b) => (
          <View key={b.label} style={styles.legendItem}>
            <Svg width={8} height={8}>
              <Circle cx={4} cy={4} r={4} fill={b.color} />
            </Svg>
            <Text style={styles.legendText}>{b.label}</Text>
          </View>
        ))}
        <View style={styles.legendItem}>
          <Svg width={8} height={8}>
            <Circle cx={4} cy={4} r={4} fill={C.brandRed} />
          </Svg>
          <Text style={styles.legendText}>Business location</Text>
        </View>
      </View>

      <Buckets ranks={entity.ranks} />

      <View style={styles.summaryRow}>
        <Text style={styles.summaryItem}>
          <Text style={styles.summaryStrong}>Avg rank: </Text>
          {ar == null ? "—" : ar.toFixed(1)}
        </Text>
        <Text style={styles.summaryItem}>
          <Text style={styles.summaryStrong}>Share of voice: </Text>
          {sov.pct.toFixed(0)}% in top 3
        </Text>
        <Text style={styles.summaryItem}>
          <Text style={styles.summaryStrong}>Found: </Text>
          {found} of {entity.ranks.length} vantage points
        </Text>
      </View>

      <View style={styles.footer}>
        <Text>
          {data.business} · {data.keyword}
        </Text>
        <Text>Harbinger SEO · GBP Heatmap</Text>
      </View>
    </Page>
  )
}

function HeatmapReport({
  data,
  xy,
  view,
  baseMap,
}: {
  data: HeatmapPdfData
  xy: { x: number; y: number }[]
  view: ViewParams
  baseMap: string | null
}) {
  return (
    <Document
      title={`GBP Heatmap — ${data.business} — ${data.keyword}`}
      author="Harbinger SEO"
    >
      <EntityPage
        data={data}
        entity={data.target}
        xy={xy}
        view={view}
        baseMap={baseMap}
      />
      {data.competitors.map((c, i) => (
        <EntityPage
          key={i}
          data={data}
          entity={c}
          xy={xy}
          view={view}
          baseMap={baseMap}
        />
      ))}
    </Document>
  )
}

export async function buildHeatmapPdfBlob(data: HeatmapPdfData): Promise<Blob> {
  // One shared base map + projection for the scanned area (geography is the
  // same across entities; only the dot colors differ per business).
  const view = fitView(data.points, SNAP_W, SNAP_H, PAD)
  const xy = data.points.map((p) => projectPoint(p.lat, p.lng, view, SNAP_W, SNAP_H))
  const baseMap = await fetchBaseMap(view)
  return pdf(
    <HeatmapReport data={data} xy={xy} view={view} baseMap={baseMap} />,
  ).toBlob()
}
