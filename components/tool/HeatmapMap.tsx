"use client"

import { useEffect, useRef } from "react"
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

/**
 * Heatmap map.
 *
 * `grid.points` defines the fixed 5×7 lattice of vantage points around the
 * scanned business — these never change between target ↔ competitor views.
 * `ranks` is a parallel array (same length, same index order) giving the
 * rank to render at each grid point for the currently-selected entity.
 * `markerLat/Lng/Title` describe the red pin overlay — the target's GBP by
 * default, the competitor's GBP when one is selected.
 */
export function HeatmapMap({
  grid,
  ranks,
  markerLat,
  markerLng,
  markerTitle,
}: {
  grid: HeatmapGridDef
  ranks: (number | null)[]
  markerLat: number
  markerLng: number
  markerTitle: string
}) {
  if (!API_KEY) return null

  return (
    <APIProvider apiKey={API_KEY}>
      <div className="h-[480px] w-full overflow-hidden rounded-lg border border-line">
        <Map
          mapId={MAP_ID}
          defaultCenter={{ lat: markerLat, lng: markerLng }}
          defaultZoom={12}
          gestureHandling="cooperative"
          mapTypeControl={false}
          streetViewControl={false}
          fullscreenControl={false}
        >
          {/* Fit-bounds runs once, against the immutable grid lattice, so
              flipping between competitors doesn't reframe the map. */}
          <FitGridOnce points={grid.points} />
          <AdvancedMarker
            position={{ lat: markerLat, lng: markerLng }}
            title={markerTitle}
            zIndex={1000}
          >
            <BusinessMarker />
          </AdvancedMarker>
          {grid.points.map((p, i) => (
            <AdvancedMarker
              key={`${p.row}-${p.col}`}
              position={{ lat: p.lat, lng: p.lng }}
              title={`Row ${p.row + 1}, Col ${p.col + 1} · rank ${
                ranks[i] ?? "out of top 100"
              }`}
            >
              <RankCircle rank={ranks[i] ?? null} />
            </AdvancedMarker>
          ))}
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

/**
 * Fit the map viewport to the grid lattice exactly once, on first paint.
 * Subsequent re-renders (e.g. when the user picks a different competitor)
 * keep the same bounds so the user's mental model of the map doesn't shift.
 */
function FitGridOnce({ points }: { points: HeatmapPoint[] }) {
  const map = useMap()
  const fittedRef = useRef(false)
  useEffect(() => {
    if (!map || fittedRef.current || points.length === 0) return
    const bounds = new google.maps.LatLngBounds()
    for (const p of points) bounds.extend({ lat: p.lat, lng: p.lng })
    map.fitBounds(bounds, 60)
    fittedRef.current = true
  }, [map, points])
  return null
}
