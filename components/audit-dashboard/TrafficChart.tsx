"use client"

import { useMemo, useState } from "react"
import type { TrafficSeriesPoint } from "@/lib/audit-dashboard-data"

/**
 * Hand-rolled SVG line chart for the YoY traffic section.
 *
 * Pure SVG keeps the standalone HTML export self-contained and small;
 * a recharts/chart.js dependency would add ~200 KB to the bundle plus
 * the export. Hover tooltips use plain React state in the app and
 * data-* + a small vanilla script in the export (see audit-html-export).
 */

const WIDTH = 720
const HEIGHT = 280
const PAD = { top: 24, right: 16, bottom: 36, left: 56 }

export function TrafficChart({ series }: { series: TrafficSeriesPoint[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  const dims = useMemo(() => {
    if (series.length === 0) {
      return { maxY: 0, currentPath: "", priorPath: "", xs: [] as number[] }
    }
    const maxY = Math.max(
      1,
      ...series.map((p) => Math.max(p.current, p.prior ?? 0)),
    )
    const innerW = WIDTH - PAD.left - PAD.right
    const innerH = HEIGHT - PAD.top - PAD.bottom
    const step = series.length > 1 ? innerW / (series.length - 1) : 0
    const xs = series.map((_, i) => PAD.left + step * i)
    const yFor = (n: number | null) =>
      n == null ? null : PAD.top + innerH - (n / maxY) * innerH
    const currentPath = series
      .map((p, i) => `${i === 0 ? "M" : "L"} ${xs[i]} ${yFor(p.current)}`)
      .join(" ")
    const priorPath = series
      .map((p, i) => {
        const y = yFor(p.prior)
        if (y == null) return ""
        return `${i === 0 ? "M" : "L"} ${xs[i]} ${y}`
      })
      .filter(Boolean)
      .join(" ")
    return { maxY, currentPath, priorPath, xs }
  }, [series])

  if (series.length === 0) {
    return (
      <p className="font-serif text-sm italic text-ink-3">
        No monthly organic data available.
      </p>
    )
  }

  const innerH = HEIGHT - PAD.top - PAD.bottom
  const yFor = (n: number) => PAD.top + innerH - (n / dims.maxY) * innerH
  const yTicks = 4
  const ticks = Array.from({ length: yTicks + 1 }, (_, i) =>
    Math.round((dims.maxY / yTicks) * i),
  )

  return (
    <div className="relative">
      <div className="mb-3 flex items-center gap-4 font-sans text-[11px] font-bold uppercase tracking-[0.16em] text-ink-2">
        <span className="inline-flex items-center gap-2">
          <span
            className="inline-block h-[3px] w-5 rounded"
            style={{ background: "#03293A" }}
          />
          Last 12 months
        </span>
        <span className="inline-flex items-center gap-2">
          <span
            className="inline-block h-[3px] w-5 rounded"
            style={{ background: "rgba(3,41,58,0.35)", borderTop: "1px dashed" }}
          />
          Prior year
        </span>
      </div>
      <div className="overflow-x-auto">
        <svg
          role="img"
          aria-label="Organic sessions, current vs prior year"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          width="100%"
          preserveAspectRatio="xMidYMid meet"
          className="block"
          onMouseLeave={() => setHoverIdx(null)}
        >
          {ticks.map((t, i) => {
            const y = yFor(t)
            return (
              <g key={i}>
                <line
                  x1={PAD.left}
                  x2={WIDTH - PAD.right}
                  y1={y}
                  y2={y}
                  stroke="#E5DED2"
                  strokeWidth={1}
                />
                <text
                  x={PAD.left - 8}
                  y={y + 3}
                  textAnchor="end"
                  fontFamily="var(--font-sans, system-ui)"
                  fontSize="10"
                  fontWeight={600}
                  fill="rgba(3,41,58,0.52)"
                >
                  {t.toLocaleString()}
                </text>
              </g>
            )
          })}
          {dims.priorPath ? (
            <path
              d={dims.priorPath}
              fill="none"
              stroke="rgba(3,41,58,0.45)"
              strokeWidth={1.5}
              strokeDasharray="4 4"
            />
          ) : null}
          <path
            d={dims.currentPath}
            fill="none"
            stroke="#03293A"
            strokeWidth={2.25}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {series.map((p, i) => {
            const x = dims.xs[i]
            const y = yFor(p.current)
            return (
              <g key={i}>
                <circle
                  cx={x}
                  cy={y}
                  r={hoverIdx === i ? 5.5 : 3.5}
                  fill={hoverIdx === i ? "#FF1E00" : "#03293A"}
                  stroke="#FFFFFF"
                  strokeWidth={1.5}
                />
                <rect
                  x={x - 18}
                  y={PAD.top - 8}
                  width={36}
                  height={HEIGHT - PAD.top - PAD.bottom + 16}
                  fill="transparent"
                  pointerEvents="all"
                  onMouseEnter={() => setHoverIdx(i)}
                />
              </g>
            )
          })}
          {series.map((p, i) => {
            if (i % Math.ceil(series.length / 6) !== 0 && i !== series.length - 1)
              return null
            return (
              <text
                key={`x-${i}`}
                x={dims.xs[i]}
                y={HEIGHT - PAD.bottom + 18}
                textAnchor="middle"
                fontFamily="var(--font-sans, system-ui)"
                fontSize="10.5"
                fontWeight={600}
                fill="rgba(3,41,58,0.52)"
              >
                {p.label}
              </text>
            )
          })}
        </svg>
      </div>
      {hoverIdx !== null ? (
        <div
          className="pointer-events-none absolute top-2 right-2 rounded-[10px] border border-line bg-card px-3 py-2 text-[12px] shadow-card"
          role="status"
        >
          <div className="font-sans font-bold uppercase tracking-[0.14em] text-ink-2">
            {series[hoverIdx].label}
          </div>
          <div className="mt-1 flex items-center justify-between gap-3 font-sans tabular-nums">
            <span className="text-ink-2">Current</span>
            <span className="font-extrabold text-foreground">
              {series[hoverIdx].current.toLocaleString()}
            </span>
          </div>
          {series[hoverIdx].prior != null ? (
            <div className="flex items-center justify-between gap-3 font-sans tabular-nums">
              <span className="text-ink-3">Prior</span>
              <span className="text-ink-2">
                {series[hoverIdx].prior!.toLocaleString()}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
