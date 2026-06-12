import {
  Circle,
  Document,
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
 * geographic "snapshot" of its rank across the scanned vantage points and the
 * position-range KPIs. The snapshot is drawn as a native @react-pdf SVG
 * (points projected from lat/lng, colored by rank) rather than a screenshot of
 * the live Google map — Google's vector/WebGL tiles can't be reliably captured
 * into a canvas/PDF from the browser, and an SVG renders deterministically.
 *
 * Built in the browser via `pdf(...).toBlob()`; the module is dynamically
 * imported so @react-pdf isn't in the page's initial bundle.
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
const PAD = 26

function avgRank(ranks: (number | null)[]): number | null {
  const nums = ranks.filter((r): r is number => typeof r === "number")
  if (nums.length === 0) return null
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

/** Project lat/lng points into the snapshot box (lat inverted for screen y). */
function project(
  points: { lat: number; lng: number }[],
): { x: number; y: number }[] {
  if (points.length === 0) return []
  const lats = points.map((p) => p.lat)
  const lngs = points.map((p) => p.lng)
  const minLat = Math.min(...lats)
  const maxLat = Math.max(...lats)
  const minLng = Math.min(...lngs)
  const maxLng = Math.max(...lngs)
  const latSpan = maxLat - minLat || 0.001
  const lngSpan = maxLng - minLng || 0.001
  return points.map((p) => ({
    x: PAD + ((p.lng - minLng) / lngSpan) * (SNAP_W - 2 * PAD),
    y: PAD + ((maxLat - p.lat) / latSpan) * (SNAP_H - 2 * PAD),
  }))
}

function Snapshot({
  points,
  ranks,
  markerLat,
  markerLng,
}: {
  points: { lat: number; lng: number }[]
  ranks: (number | null)[]
  markerLat: number | null
  markerLng: number | null
}) {
  const xy = project(points)
  const showNumbers = points.length <= 80
  const r = points.length > 90 ? 5 : points.length > 49 ? 7 : 9
  // Project the business/competitor marker into the same box.
  let marker: { x: number; y: number } | null = null
  if (markerLat != null && markerLng != null) {
    const [m] = project([
      ...points,
      { lat: markerLat, lng: markerLng },
    ]).slice(-1)
    marker = m ?? null
  }
  return (
    <View style={{ marginTop: 12 }}>
      <Svg width={SNAP_W} height={SNAP_H}>
        <Rect
          x={0}
          y={0}
          width={SNAP_W}
          height={SNAP_H}
          rx={6}
          fill={C.paper}
          stroke={C.hairline}
        />
        {/* faint reference gridlines */}
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
        {xy.map((p, i) => {
          const rank = ranks[i] ?? null
          return (
            <React.Fragment key={i}>
              <Circle
                cx={p.x}
                cy={p.y}
                r={r}
                fill={rankColor(rank)}
                stroke="#FFFFFF"
                strokeWidth={1}
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
        {marker ? (
          <Circle
            cx={marker.x}
            cy={marker.y}
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
  const buckets = positionBuckets(ranks)
  return (
    <View style={styles.kpis}>
      {buckets.map((b) => (
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
}: {
  data: HeatmapPdfData
  entity: HeatmapPdfEntity
}) {
  const ar = avgRank(entity.ranks)
  const found = entity.ranks.filter((r) => typeof r === "number").length
  const sov = positionBuckets(entity.ranks)[0]
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

      <Snapshot
        points={data.points}
        ranks={entity.ranks}
        markerLat={entity.markerLat}
        markerLng={entity.markerLng}
      />

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

function HeatmapReport({ data }: { data: HeatmapPdfData }) {
  return (
    <Document
      title={`GBP Heatmap — ${data.business} — ${data.keyword}`}
      author="Harbinger SEO"
    >
      <EntityPage data={data} entity={data.target} />
      {data.competitors.map((c, i) => (
        <EntityPage key={i} data={data} entity={c} />
      ))}
    </Document>
  )
}

export async function buildHeatmapPdfBlob(data: HeatmapPdfData): Promise<Blob> {
  return pdf(<HeatmapReport data={data} />).toBlob()
}
