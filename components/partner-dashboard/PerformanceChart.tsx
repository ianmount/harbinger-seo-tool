"use client"

import { useMemo, useState } from "react"
import type { GSCDailyRow } from "@/lib/types"

const WIDTH = 740
const HEIGHT = 240
const PAD = { top: 16, right: 56, bottom: 28, left: 56 }
const INNER_W = WIDTH - PAD.left - PAD.right
const INNER_H = HEIGHT - PAD.top - PAD.bottom

const CLICKS_COLOR = "#0EA5E9" // sky-500
const IMPRESSIONS_COLOR = "#94A3B8" // slate-400

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

function fmtDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

/**
 * Pure-SVG dual-axis line chart. Clicks on the left axis (sky), impressions
 * on the right axis (slate). Hover anywhere along the x to surface a
 * tooltip with both metric values for that day.
 *
 * Pure SVG keeps the bundle lean — recharts would add ~200 KB.
 */
export function PerformanceChart({ rows }: { rows: GSCDailyRow[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  const sorted = useMemo(
    () => rows.slice().sort((a, b) => a.date.localeCompare(b.date)),
    [rows],
  )

  const dims = useMemo(() => {
    if (sorted.length === 0) {
      return {
        maxClicks: 0,
        maxImpressions: 0,
        clicksPath: "",
        impressionsPath: "",
        xs: [] as number[],
      }
    }
    const maxClicks = Math.max(1, ...sorted.map((r) => r.clicks))
    const maxImpressions = Math.max(1, ...sorted.map((r) => r.impressions))
    const step = sorted.length > 1 ? INNER_W / (sorted.length - 1) : 0
    const xs = sorted.map((_, i) => PAD.left + step * i)
    const yClicks = (n: number) =>
      PAD.top + INNER_H - (n / maxClicks) * INNER_H
    const yImps = (n: number) =>
      PAD.top + INNER_H - (n / maxImpressions) * INNER_H

    const clicksPath = sorted
      .map((r, i) => `${i === 0 ? "M" : "L"} ${xs[i]} ${yClicks(r.clicks)}`)
      .join(" ")
    const impressionsPath = sorted
      .map(
        (r, i) =>
          `${i === 0 ? "M" : "L"} ${xs[i]} ${yImps(r.impressions)}`,
      )
      .join(" ")

    return { maxClicks, maxImpressions, clicksPath, impressionsPath, xs }
  }, [sorted])

  if (sorted.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-6 text-center text-sm text-muted-foreground">
        No daily data for this range.
      </div>
    )
  }

  // Y-axis tick labels (3 stops per axis: 0, mid, max)
  const yTicks = [0, 0.5, 1] as const
  const xLabelIndices = [
    0,
    Math.floor(sorted.length / 3),
    Math.floor((2 * sorted.length) / 3),
    sorted.length - 1,
  ]

  function handleMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * WIDTH
    const relX = x - PAD.left
    if (relX < 0 || relX > INNER_W) {
      setHoverIdx(null)
      return
    }
    const step = sorted.length > 1 ? INNER_W / (sorted.length - 1) : INNER_W
    const idx = Math.max(0, Math.min(sorted.length - 1, Math.round(relX / step)))
    setHoverIdx(idx)
  }

  const hover = hoverIdx !== null ? sorted[hoverIdx] : null
  const hoverX = hoverIdx !== null ? dims.xs[hoverIdx] : null

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-4 text-xs">
        <span className="inline-flex items-center gap-1.5">
          <span
            className="block h-0.5 w-4"
            style={{ background: CLICKS_COLOR }}
          />
          <span className="text-muted-foreground">Clicks</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="block h-0.5 w-4"
            style={{ background: IMPRESSIONS_COLOR }}
          />
          <span className="text-muted-foreground">Impressions</span>
        </span>
      </div>

      <div className="rounded-lg border border-border bg-card">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="h-auto w-full"
          onMouseMove={handleMove}
          onMouseLeave={() => setHoverIdx(null)}
        >
          {/* Y-axis (left, clicks) gridlines */}
          {yTicks.map((t) => {
            const y = PAD.top + INNER_H * (1 - t)
            return (
              <g key={`grid-${t}`}>
                <line
                  x1={PAD.left}
                  y1={y}
                  x2={WIDTH - PAD.right}
                  y2={y}
                  stroke="currentColor"
                  className="text-border"
                  strokeWidth={1}
                />
                <text
                  x={PAD.left - 6}
                  y={y + 3}
                  textAnchor="end"
                  className="fill-current text-[10px]"
                  style={{ color: CLICKS_COLOR }}
                  fill={CLICKS_COLOR}
                >
                  {fmtNum(dims.maxClicks * t)}
                </text>
                <text
                  x={WIDTH - PAD.right + 6}
                  y={y + 3}
                  textAnchor="start"
                  className="fill-current text-[10px]"
                  fill={IMPRESSIONS_COLOR}
                >
                  {fmtNum(dims.maxImpressions * t)}
                </text>
              </g>
            )
          })}

          {/* X-axis labels */}
          {xLabelIndices.map((i) => (
            <text
              key={`xl-${i}`}
              x={dims.xs[i]}
              y={HEIGHT - PAD.bottom + 16}
              textAnchor="middle"
              className="fill-current text-[10px] text-muted-foreground"
            >
              {fmtDate(sorted[i].date)}
            </text>
          ))}

          {/* Lines */}
          <path
            d={dims.impressionsPath}
            fill="none"
            stroke={IMPRESSIONS_COLOR}
            strokeWidth={1.5}
          />
          <path
            d={dims.clicksPath}
            fill="none"
            stroke={CLICKS_COLOR}
            strokeWidth={2}
          />

          {/* Hover guide + dots */}
          {hover && hoverX !== null && (
            <g>
              <line
                x1={hoverX}
                y1={PAD.top}
                x2={hoverX}
                y2={HEIGHT - PAD.bottom}
                stroke="currentColor"
                className="text-muted-foreground/40"
                strokeDasharray="3 3"
              />
              <circle
                cx={hoverX}
                cy={
                  PAD.top + INNER_H - (hover.clicks / dims.maxClicks) * INNER_H
                }
                r={3.5}
                fill={CLICKS_COLOR}
              />
              <circle
                cx={hoverX}
                cy={
                  PAD.top +
                  INNER_H -
                  (hover.impressions / dims.maxImpressions) * INNER_H
                }
                r={3.5}
                fill={IMPRESSIONS_COLOR}
              />
            </g>
          )}
        </svg>

        {hover && (
          <div className="flex items-center justify-between border-t border-border bg-muted/30 px-3 py-2 text-xs">
            <span className="font-medium">{fmtDate(hover.date)}</span>
            <div className="flex items-center gap-4">
              <span className="font-mono">
                <span style={{ color: CLICKS_COLOR }}>●</span>{" "}
                {hover.clicks.toLocaleString()} clicks
              </span>
              <span className="font-mono">
                <span style={{ color: IMPRESSIONS_COLOR }}>●</span>{" "}
                {hover.impressions.toLocaleString()} impressions
              </span>
              <span className="font-mono text-muted-foreground">
                pos {hover.position.toFixed(1)}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
