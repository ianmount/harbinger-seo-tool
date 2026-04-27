import type { GA4MonthlyOrganicRow } from "@/lib/types"

/**
 * Inline-SVG chart builders for the Audit tab's organic-sessions YoY chart.
 *
 * The output is consumed in two places: the audit markdown (rendered by
 * ReactMarkdown + rehype-raw) and, eventually, the audit PDF (@react-pdf
 * supports raw SVG). Both contexts require the SVG to be self-contained:
 * no external CSS, no JS, no <script>, no foreignObject. Everything is
 * driven by inline `fill` / `stroke` attributes pulled from the brand
 * palette in app/globals.css (--color-brand-navy, --color-brand-red).
 */

const BRAND_NAVY = "#03293a"
const BRAND_RED = "#ff1e00"
const INK_3 = "rgba(3, 41, 58, 0.52)"
const LINE = "#e5ded2"

export interface ChartSeriesPoint {
  /** YYYY-MM. */
  month: string
  sessions: number
}

export interface OrganicSessionsChartData {
  current: ChartSeriesPoint[]
  previous: ChartSeriesPoint[]
  totalCurrent: number
  totalPrevious: number
  /** Null when previous total is 0 (avoids divide-by-zero). */
  percentChange: number | null
  /** Range labels for the caption (e.g. "May 2025 – Apr 2026"). */
  currentLabel: string
  previousLabel: string
}

/**
 * Split monthly-organic rows into two 12-month series: the most recent 12
 * months ("current") and the 12 months before that ("previous"). When GA4
 * history is shorter than 24 months, the previous series is short-padded
 * with nulls so the X axis still aligns 1:1 by index.
 */
export function buildSeries(rows: GA4MonthlyOrganicRow[]): OrganicSessionsChartData | null {
  if (rows.length === 0) return null

  // Sort ascending by month string — yearMonth is already lex-ordered.
  const sorted = [...rows].sort((a, b) => a.month.localeCompare(b.month))
  const last24 = sorted.slice(-24)

  const current = last24.slice(-12)
  const previous = last24.slice(0, Math.max(0, last24.length - 12))

  if (current.length === 0) return null

  const toPoints = (rs: GA4MonthlyOrganicRow[]): ChartSeriesPoint[] =>
    rs.map((r) => ({ month: r.month, sessions: r.sessions }))

  const totalCurrent = current.reduce((s, r) => s + r.sessions, 0)
  const totalPrevious = previous.reduce((s, r) => s + r.sessions, 0)
  const percentChange =
    totalPrevious > 0
      ? ((totalCurrent - totalPrevious) / totalPrevious) * 100
      : null

  return {
    current: toPoints(current),
    previous: toPoints(previous),
    totalCurrent,
    totalPrevious,
    percentChange,
    currentLabel: rangeLabel(current),
    previousLabel: previous.length > 0 ? rangeLabel(previous) : "(no prior data)",
  }
}

function rangeLabel(rs: GA4MonthlyOrganicRow[] | ChartSeriesPoint[]): string {
  if (rs.length === 0) return ""
  const first = formatMonth(rs[0].month)
  const last = formatMonth(rs[rs.length - 1].month)
  return `${first} – ${last}`
}

function formatMonth(yyyymm: string): string {
  // yyyymm is "YYYY-MM"; build "MMM YYYY" without timezone surprises.
  const [yStr, mStr] = yyyymm.split("-")
  const y = Number(yStr)
  const m = Number(mStr)
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return yyyymm
  return `${MONTH_ABBR[m - 1]} ${y}`
}

const MONTH_ABBR = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
]

function monthAbbrFromYearMonth(yyyymm: string): string {
  const m = Number(yyyymm.split("-")[1])
  if (!Number.isFinite(m) || m < 1 || m > 12) return ""
  return MONTH_ABBR[m - 1]
}

function formatNumber(n: number): string {
  return Math.round(n).toLocaleString("en-US")
}

function formatPercent(p: number): string {
  const sign = p > 0 ? "+" : ""
  return `${sign}${p.toFixed(1)}%`
}

interface PlotMath {
  x: (i: number) => number
  y: (v: number) => number
  yMax: number
}

function plotMath(opts: {
  pointCount: number
  maxValue: number
  innerLeft: number
  innerRight: number
  innerTop: number
  innerBottom: number
}): PlotMath {
  const { pointCount, maxValue, innerLeft, innerRight, innerTop, innerBottom } =
    opts
  const yMax = niceCeiling(Math.max(maxValue, 1))
  const denomX = Math.max(1, pointCount - 1)
  return {
    x: (i: number) => innerLeft + (i / denomX) * (innerRight - innerLeft),
    y: (v: number) =>
      innerBottom - (v / yMax) * (innerBottom - innerTop),
    yMax,
  }
}

/**
 * Round up to a "nice" number for the Y axis (1, 2, 2.5, 5, 10 × 10^k).
 * Keeps the top gridline a friendly integer like 5,000 / 25,000 / 100,000.
 */
function niceCeiling(value: number): number {
  if (value <= 0) return 1
  const exp = Math.floor(Math.log10(value))
  const base = Math.pow(10, exp)
  const norm = value / base
  let nice: number
  if (norm <= 1) nice = 1
  else if (norm <= 2) nice = 2
  else if (norm <= 2.5) nice = 2.5
  else if (norm <= 5) nice = 5
  else nice = 10
  return nice * base
}

function pointsToPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return ""
  return points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${round(p.x)} ${round(p.y)}`)
    .join(" ")
}

function round(n: number): number {
  return Math.round(n * 10) / 10
}

/**
 * Full YoY line chart. Width 720, height 280 — fits the audit article's max
 * column width without overflow. Includes title, two-series legend, X axis
 * (12 month abbreviations), Y axis (4 gridlines + labels), and a caption
 * with summary stats.
 */
export function renderOrganicSessionsChartSvg(
  data: OrganicSessionsChartData,
): string {
  const width = 720
  const height = 320
  const padTop = 40
  const padRight = 24
  const padBottom = 64
  const padLeft = 64

  const innerLeft = padLeft
  const innerRight = width - padRight
  const innerTop = padTop
  const innerBottom = height - padBottom

  const seriesMax = Math.max(
    ...data.current.map((p) => p.sessions),
    ...data.previous.map((p) => p.sessions),
    0,
  )

  const m = plotMath({
    pointCount: data.current.length,
    maxValue: seriesMax,
    innerLeft,
    innerRight,
    innerTop,
    innerBottom,
  })

  const currentPoints = data.current.map((p, i) => ({
    x: m.x(i),
    y: m.y(p.sessions),
  }))
  // Previous series is plotted on the same X positions so months align by
  // calendar position. If GA4 history is shorter and previous has fewer
  // points than current, anchor previous to the LEFT side and let it stop
  // mid-chart — better than pretending we have data we don't.
  const previousPoints = data.previous.map((p, i) => ({
    x: m.x(i),
    y: m.y(p.sessions),
  }))

  const gridlines = 4
  const gridY: { y: number; label: string }[] = []
  for (let i = 0; i <= gridlines; i++) {
    const v = (m.yMax * i) / gridlines
    gridY.push({ y: m.y(v), label: formatNumber(v) })
  }

  const xLabels = data.current.map((p) => monthAbbrFromYearMonth(p.month))

  const lines: string[] = []
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Organic sessions, current 12 months vs prior 12 months" style="max-width:100%;height:auto;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif">`,
  )

  // Title.
  lines.push(
    `<text x="${padLeft}" y="22" font-size="13" font-weight="700" fill="${BRAND_NAVY}">Organic sessions — year over year</text>`,
  )

  // Legend.
  const legendY = 22
  const legendX = width - padRight
  const legendCurrentLabel = "Current 12 months"
  const legendPreviousLabel = "Prior 12 months"
  lines.push(
    `<g font-size="11" fill="${BRAND_NAVY}">` +
      `<line x1="${legendX - 230}" y1="${legendY - 4}" x2="${legendX - 212}" y2="${legendY - 4}" stroke="${BRAND_NAVY}" stroke-width="2.5"/>` +
      `<text x="${legendX - 208}" y="${legendY}" text-anchor="start">${escapeXml(legendCurrentLabel)}</text>` +
      `<line x1="${legendX - 110}" y1="${legendY - 4}" x2="${legendX - 92}" y2="${legendY - 4}" stroke="${BRAND_RED}" stroke-width="2.5" stroke-dasharray="4 3"/>` +
      `<text x="${legendX - 88}" y="${legendY}" text-anchor="start">${escapeXml(legendPreviousLabel)}</text>` +
      `</g>`,
  )

  // Gridlines + Y labels.
  for (const g of gridY) {
    lines.push(
      `<line x1="${innerLeft}" y1="${round(g.y)}" x2="${innerRight}" y2="${round(g.y)}" stroke="${LINE}" stroke-width="1"/>`,
    )
    lines.push(
      `<text x="${innerLeft - 8}" y="${round(g.y) + 3}" font-size="10" fill="${INK_3}" text-anchor="end">${escapeXml(g.label)}</text>`,
    )
  }

  // X labels.
  for (let i = 0; i < xLabels.length; i++) {
    const x = m.x(i)
    lines.push(
      `<text x="${round(x)}" y="${innerBottom + 16}" font-size="10" fill="${INK_3}" text-anchor="middle">${escapeXml(xLabels[i])}</text>`,
    )
  }

  // Previous series line — drawn first so the current line sits on top.
  if (previousPoints.length > 1) {
    lines.push(
      `<path d="${pointsToPath(previousPoints)}" fill="none" stroke="${BRAND_RED}" stroke-width="2" stroke-dasharray="4 3" stroke-linecap="round" stroke-linejoin="round"/>`,
    )
  }

  // Current series line.
  if (currentPoints.length > 1) {
    lines.push(
      `<path d="${pointsToPath(currentPoints)}" fill="none" stroke="${BRAND_NAVY}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`,
    )
  }

  // Current series end-point dot for emphasis.
  const last = currentPoints[currentPoints.length - 1]
  if (last) {
    lines.push(
      `<circle cx="${round(last.x)}" cy="${round(last.y)}" r="3.5" fill="${BRAND_NAVY}"/>`,
    )
  }

  // Caption row at the bottom of the SVG.
  const captionY = height - 24
  const captionParts: string[] = []
  captionParts.push(
    `Current (${escapeXml(data.currentLabel)}): ${formatNumber(data.totalCurrent)} sessions`,
  )
  captionParts.push(
    `Prior (${escapeXml(data.previousLabel)}): ${formatNumber(data.totalPrevious)} sessions`,
  )
  if (data.percentChange !== null) {
    captionParts.push(`YoY: ${formatPercent(data.percentChange)}`)
  } else {
    captionParts.push("YoY: n/a")
  }
  lines.push(
    `<text x="${padLeft}" y="${captionY}" font-size="11" fill="${BRAND_NAVY}">${captionParts.map(escapeXml).join("  ·  ")}</text>`,
  )

  lines.push(`</svg>`)
  return lines.join("")
}

/**
 * Sparkline-only version — current 12-month series, no axes, no legend.
 * Sized at 120×32 by default; embeds inline next to a sentence.
 */
export function renderOrganicSessionsSparklineSvg(
  data: OrganicSessionsChartData,
  opts: { width?: number; height?: number } = {},
): string {
  const width = opts.width ?? 120
  const height = opts.height ?? 32
  const pad = 2

  if (data.current.length === 0) return ""

  const max = Math.max(...data.current.map((p) => p.sessions), 1)
  const denom = Math.max(1, data.current.length - 1)
  const points = data.current.map((p, i) => ({
    x: pad + (i / denom) * (width - 2 * pad),
    y: height - pad - (p.sessions / max) * (height - 2 * pad),
  }))

  const path = pointsToPath(points)
  const last = points[points.length - 1]
  const direction =
    data.percentChange === null
      ? BRAND_NAVY
      : data.percentChange >= 0
        ? BRAND_NAVY
        : BRAND_RED

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Organic sessions sparkline, last 12 months" style="vertical-align:middle">`,
    `<path d="${path}" fill="none" stroke="${direction}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
    `<circle cx="${round(last.x)}" cy="${round(last.y)}" r="2" fill="${direction}"/>`,
    `</svg>`,
  ].join("")
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

/**
 * Build the full markdown block to insert immediately after the
 * "## Traffic & Visibility" heading: the SVG chart, a blank line, and a
 * caption line with the summary stats.
 */
export function renderOrganicSessionsBlock(
  data: OrganicSessionsChartData,
): string {
  const svg = renderOrganicSessionsChartSvg(data)
  const yoyText =
    data.percentChange !== null ? formatPercent(data.percentChange) : "n/a"
  const caption =
    `*Total sessions — current ${data.currentLabel}: **${formatNumber(data.totalCurrent)}** ` +
    `· prior ${data.previousLabel}: **${formatNumber(data.totalPrevious)}** ` +
    `· YoY change: **${yoyText}**.*`
  return `${svg}\n\n${caption}\n`
}
