"use client"

import { useEffect } from "react"
import {
  AdvancedMarker,
  APIProvider,
  Map,
  useMap,
} from "@vis.gl/react-google-maps"
import { rankColor } from "@/lib/gbp-heatmap"

// Inlined at build time. When unset, the parent page falls back to the
// SVG grid; this component never renders without a key.
const API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
// AdvancedMarker requires a mapId. Google provides "DEMO_MAP_ID" for
// development; for production, create a Map ID in Cloud Console → Maps
// → Map Management and override via NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID.
const MAP_ID = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID ?? "DEMO_MAP_ID"

export type HeatmapPoint = {
  row: number
  col: number
  lat: number
  lng: number
  rank: number | null
}

export type HeatmapGridDef = {
  rows: number
  cols: number
  spacing_km: number
  points: HeatmapPoint[]
}

export function isGoogleMapsConfigured(): boolean {
  return Boolean(API_KEY)
}

export function HeatmapMap({
  grid,
  centerLat,
  centerLng,
  businessTitle,
}: {
  grid: HeatmapGridDef
  centerLat: number
  centerLng: number
  businessTitle: string
}) {
  if (!API_KEY) return null
  const targetRow = Math.floor(grid.rows / 2)
  const targetCol = Math.floor(grid.cols / 2)

  return (
    <APIProvider apiKey={API_KEY}>
      <div className="h-[480px] w-full overflow-hidden rounded-lg border border-line">
        <Map
          mapId={MAP_ID}
          defaultCenter={{ lat: centerLat, lng: centerLng }}
          defaultZoom={12}
          gestureHandling="cooperative"
          mapTypeControl={false}
          streetViewControl={false}
          fullscreenControl={false}
        >
          <AutoFitBounds points={grid.points} />
          <AdvancedMarker
            position={{ lat: centerLat, lng: centerLng }}
            title={businessTitle}
            zIndex={1000}
          >
            <BusinessMarker />
          </AdvancedMarker>
          {grid.points.map((p) => {
            const isCenter = p.row === targetRow && p.col === targetCol
            // Skip rendering a rank circle at the exact business location
            // — the red business marker already occupies that pin.
            if (isCenter) return null
            return (
              <AdvancedMarker
                key={`${p.row}-${p.col}`}
                position={{ lat: p.lat, lng: p.lng }}
                title={`Row ${p.row + 1}, Col ${p.col + 1} · rank ${
                  p.rank ?? "out of top 100"
                }`}
              >
                <RankCircle rank={p.rank} />
              </AdvancedMarker>
            )
          })}
        </Map>
      </div>
    </APIProvider>
  )
}

function RankCircle({ rank }: { rank: number | null }) {
  return (
    <div
      style={{
        width: 36,
        height: 36,
        borderRadius: 18,
        background: rankColor(rank),
        color: "white",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "system-ui, sans-serif",
        fontSize: 13,
        fontWeight: 600,
        border: "2px solid white",
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.35)",
        userSelect: "none",
        transform: "translateY(18px)",
      }}
    >
      {rank == null ? "—" : rank}
    </div>
  )
}

function BusinessMarker() {
  return (
    <div
      style={{
        width: 22,
        height: 22,
        borderRadius: 11,
        background: "#FF1E00",
        border: "3px solid white",
        boxShadow: "0 1px 4px rgba(0, 0, 0, 0.45)",
        transform: "translateY(11px)",
      }}
      aria-label="Business location"
    />
  )
}

function AutoFitBounds({ points }: { points: HeatmapPoint[] }) {
  const map = useMap()
  useEffect(() => {
    if (!map || points.length === 0) return
    const bounds = new google.maps.LatLngBounds()
    for (const p of points) bounds.extend({ lat: p.lat, lng: p.lng })
    // 60px padding gives room around the corner markers so they don't
    // sit flush against the map edge.
    map.fitBounds(bounds, 60)
  }, [map, points])
  return null
}
