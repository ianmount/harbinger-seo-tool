import GithubSlugger from "github-slugger"
import type {
  CannibalizationSection,
  CompetitorsSection,
  DashboardData,
  IndexationSection,
  OpportunitiesSection,
  PerformanceSection,
  SchemaSection,
  TopPagesSection,
  TrafficSection,
  TrafficSeriesPoint,
} from "@/lib/audit-dashboard-data"
import { STANDALONE_CSS } from "./audit-html-export-styles"

/**
 * Renders a self-contained HTML file from a `DashboardData` snapshot. The
 * resulting string includes inlined CSS, vanilla JS for interactivity, and
 * all data — no external assets, no fetches. Safe to email as an attachment.
 */
export function renderStandaloneHtml(data: DashboardData): string {
  const date = data.generatedAt.slice(0, 10)
  const title = `SEO Audit — ${data.domain}`
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(title)}</title>
<meta name="generator" content="Harbinger SEO Tool" />
<style>${STANDALONE_CSS}</style>
</head>
<body>
<div class="print-cover" aria-hidden="true">
  <div>
    <p class="eyebrow red">Harbinger Marketing</p>
    <p class="title">SEO Audit</p>
    <p class="domain">${escapeHtml(data.domain)}</p>
    <p class="meta">Prepared ${escapeHtml(date)}<br/>Confidential — for ${escapeHtml(data.domain)} and Harbinger Marketing</p>
  </div>
</div>
<div class="container">
  <div class="layout">
    ${renderToc(data)}
    <div>
      ${renderHero(data, date)}
      ${renderOverview(data)}
      ${renderExecutiveSummary(data)}
      ${data.indexation ? renderIndexation(data.indexation) : ""}
      ${data.cannibalization.clusters.length > 0 ? renderCannibalization(data.cannibalization) : ""}
      ${data.traffic ? renderTraffic(data.traffic) : ""}
      ${data.competitors ? renderCompetitors(data.competitors) : ""}
      ${data.schema ? renderSchema(data.schema) : ""}
      ${data.opportunities ? renderOpportunities(data.opportunities) : ""}
      ${data.topPages ? renderTopPages(data.topPages) : ""}
      ${data.performance ? renderPerformance(data.performance) : ""}
      ${renderNarrative(data)}
    </div>
  </div>
</div>
<script>${INTERACTIVITY_JS}</script>
</body>
</html>`
}

function renderToc(data: DashboardData): string {
  const items: { id: string; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "executive-summary", label: "Executive Summary" },
  ]
  if (data.indexation) items.push({ id: "indexation", label: "Indexation" })
  if (data.cannibalization.clusters.length > 0)
    items.push({ id: "cannibalization", label: "Cannibalization" })
  if (data.traffic) items.push({ id: "traffic", label: "Traffic (YoY)" })
  if (data.competitors) items.push({ id: "competitors", label: "Competitors" })
  if (data.schema) items.push({ id: "schema", label: "Schema Coverage" })
  if (data.opportunities)
    items.push({ id: "opportunities", label: "Top Opportunities" })
  if (data.topPages) items.push({ id: "top-pages", label: "Top Pages" })
  if (data.performance) items.push({ id: "performance", label: "Site Health" })
  // In-narrative sections — anchor IDs are emitted by markdownToBasicHtml
  // using the same slug algorithm as rehype-slug (github-slugger). Gated on
  // narrative.outline so dead links don't show up when a section is omitted.
  const outlineHas = (id: string) =>
    data.narrative.outline.some((o) => o.id === id)
  if (outlineHas("backlink-profile"))
    items.push({ id: "backlink-profile", label: "Backlinks" })
  if (outlineHas("heading-structure-h1h2"))
    items.push({ id: "heading-structure-h1h2", label: "H1/H2 Headings" })
  if (outlineHas("image-alt-text-coverage"))
    items.push({ id: "image-alt-text-coverage", label: "Alt Tags" })
  items.push({ id: "narrative", label: "Full Narrative" })
  return `<aside class="toc">
    <p class="eyebrow red">Table of Contents</p>
    <nav>
      <ul>
        ${items
          .map(
            (i) =>
              `<li><a href="#${i.id}" data-toc>${escapeHtml(i.label)}</a></li>`,
          )
          .join("")}
      </ul>
    </nav>
  </aside>`
}

function renderHero(data: DashboardData, date: string): string {
  const warnings =
    data.warnings.length > 0
      ? `<div class="warnings"><strong>Warnings (${data.warnings.length})</strong><ul>${data.warnings
          .map((w) => `<li>${escapeHtml(w)}</li>`)
          .join("")}</ul></div>`
      : ""
  return `<header class="hero">
    <div class="hero-row">
      <div>
        <p class="eyebrow red">SEO Audit</p>
        <h1>${escapeHtml(data.domain)}</h1>
        <p class="meta">Audit prepared ${escapeHtml(date)} · Generated in <b>${data.durationMinutes}</b> minute${data.durationMinutes === 1 ? "" : "s"} · Prepared by <b>Harbinger Marketing</b></p>
      </div>
      <div class="btn-row">
        <button type="button" class="btn btn-primary" onclick="window.print()">Download as PDF</button>
      </div>
    </div>
    ${warnings}
  </header>`
}

function renderOverview(data: DashboardData): string {
  return `<section id="overview" class="overview">
    <p class="eyebrow red">Overview</p>
    <div class="kpi-grid">
      ${data.summary
        .map(
          (k) =>
            `<div class="kpi"><p class="lbl">${escapeHtml(k.label)}</p><p class="val">${escapeHtml(k.value)}</p>${k.hint ? `<p class="hnt">${escapeHtml(k.hint)}</p>` : ""}</div>`,
        )
        .join("")}
    </div>
  </section>`
}

function renderSection(
  id: string,
  eyebrow: string,
  title: string,
  meta: string,
  body: string,
  collapsed = false,
): string {
  return `<section id="${id}" class="section" data-collapsed="${collapsed}">
    <button type="button" class="section-toggle" data-section-toggle>
      <div>
        <p class="eyebrow red">${escapeHtml(eyebrow)}</p>
        <h2>${escapeHtml(title)}</h2>
        ${meta ? `<p class="meta">${escapeHtml(meta)}</p>` : ""}
      </div>
      <svg class="chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>
    </button>
    <div class="section-body">${body}</div>
  </section>`
}

function renderExecutiveSummary(data: DashboardData): string {
  const { headline, bullets } = data.executiveSummary
  const body =
    bullets.length === 0
      ? `<p style="font-style:italic;color:rgba(3,41,58,0.52)">No summary bullets parsed from the synthesis.</p>`
      : `<ol class="summary">${bullets
          .map(
            (b, i) =>
              `<li><span class="num">${i + 1}</span><span>${escapeHtml(b)}</span></li>`,
          )
          .join("")}</ol>`
  return renderSection(
    "executive-summary",
    "§ 01",
    "Executive Summary",
    headline,
    body,
  )
}

function renderIndexation(data: IndexationSection): string {
  const meta = `${data.indexedCount} of ${data.sitemapCount} sitemap URLs received impressions in the 90-day window.`
  if (data.notIndexed.length === 0) {
    return renderSection(
      "indexation",
      "§ 02",
      "Indexation Status",
      meta,
      `<p style="font-style:italic;color:rgba(3,41,58,0.52)">Every sitemap URL received impressions in the window.</p>`,
    )
  }
  const cols = [
    { key: "pattern", label: "URL Pattern", num: false },
    { key: "url", label: "URL", num: false },
    { key: "lastCrawl", label: "Last Crawl", num: false },
    { key: "coverageState", label: "Coverage", num: false },
  ]
  const rows = data.notIndexed.map((r) => ({
    pattern: r.pattern,
    url: r.url,
    lastCrawl: r.lastCrawl ?? "—",
    coverageState: r.coverageState ?? "—",
  }))
  const tableId = "tbl-indexation"
  const body = `
    <input type="search" class="filter" placeholder="Filter URLs (pattern, coverage state)..." data-filter-target="${tableId}" />
    ${renderTable(tableId, cols, rows, { initialSort: "pattern", initialDir: "asc", linkCol: "url" })}
  `
  return renderSection("indexation", "§ 02", "Indexation Status", meta, body)
}

function renderCannibalization(data: CannibalizationSection): string {
  if (data.clusters.length === 0) {
    return renderSection(
      "cannibalization",
      "§ 03",
      "Keyword Cannibalization",
      "Pages competing with each other for the same query, title, or URL pattern.",
      `<p style="font-style:italic;color:rgba(3,41,58,0.52)">No cannibalization clusters detected.</p>`,
    )
  }
  const items = data.clusters
    .map((c, i) => {
      const heading = c.sharedTitle ?? c.topQuery ?? c.cluster[0]
      const rowsHtml = c.urls
        .map(
          (u) =>
            `<tr><td><a href="${escapeAttr(u.url)}" target="_blank" rel="noreferrer">${escapeHtml(u.url)}</a></td><td class="right">${u.clicks.toLocaleString()}</td><td class="right">${u.impressions.toLocaleString()}</td><td class="right">${u.position ? u.position.toFixed(1) : "—"}</td></tr>`,
        )
        .join("")
      return `<li class="cluster" data-open="false">
        <button type="button" class="cluster-toggle" data-cluster-toggle>
          <div>
            <p style="font-family:'Montserrat',system-ui,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:rgba(3,41,58,0.52);margin:0">Cluster #${i + 1} · ${escapeHtml(c.signalLabel)}</p>
            <p style="margin:2px 0 0 0;font-size:14px">${escapeHtml(heading)}</p>
            <p style="margin:4px 0 0 0;font-style:italic;font-size:12.5px;color:rgba(3,41,58,0.74)">${c.cluster.length} pages · ${escapeHtml(c.recommendationLabel)}</p>
          </div>
          <svg class="chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>
        </button>
        <div class="body">
          <div class="table-wrap"><table>
            <thead><tr><th>URL</th><th class="right">Clicks</th><th class="right">Impr</th><th class="right">Pos</th></tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table></div>
        </div>
      </li>`
    })
    .join("")
  const body = `
    <p style="font-style:italic;color:rgba(3,41,58,0.74);margin:0 0 12px 0">${data.clusters.length} cluster${data.clusters.length === 1 ? "" : "s"} — ${data.totalUrls} total URLs.</p>
    <ul style="list-style:none;padding:0;margin:0">${items}</ul>
  `
  return renderSection(
    "cannibalization",
    "§ 03",
    "Keyword Cannibalization",
    "Pages competing for the same query, title, or URL pattern.",
    body,
  )
}

function renderTraffic(data: TrafficSection): string {
  const delta = data.sessionsDeltaPct
  const deltaLabel =
    delta == null
      ? "No prior-year data"
      : `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}% YoY`
  const meta = `${data.sessionsCurrent.toLocaleString()} sessions in last 12 months · ${deltaLabel}`
  const chart = renderTrafficSvg(data.series)
  const channels =
    data.channels.length === 0
      ? ""
      : `<div style="margin-top:24px">
          <p class="eyebrow" style="margin-bottom:12px">Channel mix · last 12 months</p>
          ${data.channels
            .map(
              (c) => `<div class="channel-row">
                <span style="font-family:'Montserrat',system-ui,sans-serif;font-size:12px;font-weight:600">${escapeHtml(c.channel)}</span>
                <span class="channel-bar"><span style="width:${Math.min(100, c.sharePct).toFixed(1)}%"></span></span>
                <span style="text-align:right;font-family:'Montserrat',system-ui,sans-serif;font-variant-numeric:tabular-nums;font-size:12.5px;color:rgba(3,41,58,0.74)">${c.sessions.toLocaleString()} · ${c.sharePct.toFixed(1)}%</span>
              </div>`,
            )
            .join("")}
        </div>`
  return renderSection(
    "traffic",
    "§ 04",
    "Organic Traffic — Year over Year",
    meta,
    chart + channels,
  )
}

function renderTrafficSvg(series: TrafficSeriesPoint[]): string {
  if (series.length === 0) {
    return `<p style="font-style:italic;color:rgba(3,41,58,0.52)">No monthly organic data available.</p>`
  }
  const W = 720
  const H = 280
  const PAD = { top: 24, right: 16, bottom: 36, left: 56 }
  const innerW = W - PAD.left - PAD.right
  const innerH = H - PAD.top - PAD.bottom
  const maxY = Math.max(
    1,
    ...series.map((p) => Math.max(p.current, p.prior ?? 0)),
  )
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
  const ticks = 4
  const tickValues = Array.from({ length: ticks + 1 }, (_, i) =>
    Math.round((maxY / ticks) * i),
  )
  const gridLines = tickValues
    .map((t) => {
      const y = yFor(t) as number
      return `<line x1="${PAD.left}" x2="${W - PAD.right}" y1="${y}" y2="${y}" stroke="#E5DED2" stroke-width="1"/>
        <text x="${PAD.left - 8}" y="${y + 3}" text-anchor="end" font-family="Montserrat,system-ui,sans-serif" font-size="10" font-weight="600" fill="rgba(3,41,58,0.52)">${t.toLocaleString()}</text>`
    })
    .join("")
  const points = series
    .map((p, i) => {
      const x = xs[i]
      const y = yFor(p.current) as number
      const data = JSON.stringify({
        label: p.label,
        current: p.current,
        prior: p.prior,
      })
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
      return `<circle data-pt="${data}" cx="${x}" cy="${y}" r="3.5" fill="#03293A" stroke="#fff" stroke-width="1.5"/>`
    })
    .join("")
  const xLabels = series
    .map((p, i) => {
      if (i % Math.ceil(series.length / 6) !== 0 && i !== series.length - 1)
        return ""
      return `<text x="${xs[i]}" y="${H - PAD.bottom + 18}" text-anchor="middle" font-family="Montserrat,system-ui,sans-serif" font-size="10.5" font-weight="600" fill="rgba(3,41,58,0.52)">${escapeHtml(p.label)}</text>`
    })
    .join("")
  const legend = `<div style="display:flex;gap:16px;font-family:'Montserrat',system-ui,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:rgba(3,41,58,0.74);margin-bottom:8px">
    <span style="display:inline-flex;align-items:center;gap:8px"><span style="display:inline-block;width:20px;height:3px;background:#03293A"></span>Last 12 months</span>
    <span style="display:inline-flex;align-items:center;gap:8px"><span style="display:inline-block;width:20px;height:0;border-top:2px dashed rgba(3,41,58,0.45)"></span>Prior year</span>
  </div>`
  return `${legend}<div style="position:relative" data-traffic-chart>
    <svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Organic sessions, current vs prior year">
      ${gridLines}
      ${priorPath ? `<path d="${priorPath}" fill="none" stroke="rgba(3,41,58,0.45)" stroke-width="1.5" stroke-dasharray="4 4"/>` : ""}
      <path d="${currentPath}" fill="none" stroke="#03293A" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"/>
      ${points}
      ${xLabels}
    </svg>
  </div>`
}

function renderCompetitors(data: CompetitorsSection): string {
  const tabs = data.locations
    .map(
      (loc, i) =>
        `<button type="button" data-tab-trigger="${loc.locationCode}"${i === 0 ? ' class="active"' : ""}>${escapeHtml(loc.label)}</button>`,
    )
    .join("")
  const panels = data.locations
    .map(
      (loc, i) => `<div class="tab-panel${i === 0 ? " active" : ""}" data-tab-panel="${loc.locationCode}">
      <div class="table-wrap"><table>
        <thead><tr><th>Domain</th><th class="right">Traffic</th><th class="right">Top 3</th><th class="right">Top 10</th><th class="right">Ref Domains</th><th class="right">Pages</th></tr></thead>
        <tbody>${loc.rows
          .map(
            (r) => `<tr${r.isPartner ? ' style="background:rgba(255,30,0,0.05)"' : ""}>
            <td>${r.isPartner ? `<strong>${escapeHtml(r.domain)}</strong> <span class="badge subject">Subject</span>` : escapeHtml(r.domain)}</td>
            <td class="right">${escapeHtml(r.organicTraffic)}</td>
            <td class="right">${r.top3.toLocaleString()}</td>
            <td class="right">${r.top10.toLocaleString()}</td>
            <td class="right">${r.referringDomains.toLocaleString()}</td>
            <td class="right">${r.pagesIndexed.toLocaleString()}</td>
          </tr>`,
          )
          .join("")}</tbody>
      </table></div>
    </div>`,
    )
    .join("")
  const body = `<div data-tab-group>
    <div class="tab-strip">${tabs}</div>
    ${panels}
  </div>`
  return renderSection(
    "competitors",
    "§ 05",
    "Competitor Snapshot by Location",
    `${data.locations.length} location${data.locations.length === 1 ? "" : "s"} surveyed.`,
    body,
  )
}

function renderSchema(data: SchemaSection): string {
  const rows = data.matrix
    .map(
      (r) =>
        `<tr><td><strong>${escapeHtml(r.type)}</strong></td><td>${r.present ? '<span class="badge success">Present</span>' : '<span class="badge warning">Missing</span>'}</td><td>${escapeHtml(r.note)}</td></tr>`,
    )
    .join("")
  const chips =
    data.typesPresent.length === 0
      ? ""
      : `<div style="margin-top:20px">
          <p class="eyebrow" style="margin-bottom:8px">All types detected on the site</p>
          <div class="chip-row">${data.typesPresent.map((t) => `<span class="chip">${escapeHtml(t)}</span>`).join("")}</div>
        </div>`
  const body = `<div class="table-wrap"><table>
    <thead><tr><th>Schema type</th><th>Status</th><th>Why it matters</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>${chips}`
  return renderSection("schema", "§ 06", "Schema Coverage", "", body)
}

function renderOpportunities(data: OpportunitiesSection): string {
  const cols = [
    { key: "query", label: "Query", num: false },
    { key: "impressions", label: "Impressions", num: true },
    { key: "clicks", label: "Clicks", num: true },
    { key: "position", label: "Position", num: true },
    { key: "ctr", label: "CTR", num: true },
    { key: "estimatedClickLift", label: "Est Lift", num: true },
  ]
  const rows = data.rows.map((r) => ({
    query: r.query,
    impressions: r.impressions,
    clicks: r.clicks,
    position: Number(r.position.toFixed(1)),
    ctr: Number((r.ctr * 100).toFixed(1)),
    estimatedClickLift: r.estimatedClickLift,
  }))
  const tableId = "tbl-opps"
  const body = `
    <input type="search" class="filter" placeholder="Filter queries..." data-filter-target="${tableId}" />
    ${renderTable(tableId, cols, rows, { initialSort: "estimatedClickLift", initialDir: "desc", suffixCols: { ctr: "%" } })}
  `
  return renderSection(
    "opportunities",
    "§ 07",
    "Top Opportunities",
    "Queries ranking 3–25. Lift assumes a top-3 CTR of 18%.",
    body,
  )
}

function renderTopPages(data: TopPagesSection): string {
  const cols = [
    { key: "page", label: "Page", num: false },
    { key: "clicks", label: "Clicks", num: true },
    { key: "impressions", label: "Impressions", num: true },
    { key: "position", label: "Position", num: true },
  ]
  const rows = data.rows.map((r) => ({
    page: r.page,
    clicks: r.clicks,
    impressions: r.impressions,
    position: Number(r.position.toFixed(1)),
  }))
  const tableId = "tbl-pages"
  const body = `
    <input type="search" class="filter" placeholder="Filter pages..." data-filter-target="${tableId}" />
    ${renderTable(tableId, cols, rows, { initialSort: "clicks", initialDir: "desc", linkCol: "page" })}
  `
  return renderSection(
    "top-pages",
    "§ 08",
    "Top Landing Pages",
    "Highest-traffic pages over the 16-month window.",
    body,
  )
}

function renderPerformance(data: PerformanceSection): string {
  const stats: { label: string; value: string }[] = [
    { label: "Pages crawled", value: data.pagesAnalyzed.toLocaleString() },
    { label: "Missing titles", value: data.missingTitles.toLocaleString() },
    { label: "Missing descriptions", value: data.missingDescriptions.toLocaleString() },
    { label: "Duplicate titles", value: data.duplicateTitles.toLocaleString() },
    { label: "Duplicate descriptions", value: data.duplicateDescriptions.toLocaleString() },
    { label: "Thin content pages", value: data.thinContentPages.toLocaleString() },
    { label: "SPA shell pages", value: data.spaShellPages.toLocaleString() },
  ]
  const body = `<ul style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;list-style:none;padding:0;margin:0">${stats
    .map(
      (s) =>
        `<li style="display:flex;align-items:baseline;justify-content:space-between;border:1px solid #e5ded2;background:rgba(250,247,242,0.4);border-radius:10px;padding:12px 16px"><span style="font-family:'Montserrat',system-ui,sans-serif;font-size:11.5px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:rgba(3,41,58,0.74)">${escapeHtml(s.label)}</span><span style="font-family:'Montserrat',system-ui,sans-serif;font-size:18px;font-weight:800;font-variant-numeric:tabular-nums">${escapeHtml(s.value)}</span></li>`,
    )
    .join("")}</ul>`
  return renderSection(
    "performance",
    "§ 09",
    "Site Health",
    "On-page issues surfaced by the crawl.",
    body,
  )
}

function renderNarrative(data: DashboardData): string {
  const html = markdownToBasicHtml(data.narrative.markdown)
  return renderSection(
    "narrative",
    "§ 10",
    "Full Audit Narrative",
    "Claude's full synthesis — supports the structured sections above.",
    `<div class="narrative">${html}</div>`,
    /* collapsed */ false,
  )
}

interface TableCol {
  key: string
  label: string
  num: boolean
}

interface TableOptions {
  initialSort?: string
  initialDir?: "asc" | "desc"
  linkCol?: string
  /** Suffix appended to numeric cell display, keyed by column id (e.g. "%"). */
  suffixCols?: Record<string, string>
}

function renderTable(
  id: string,
  cols: TableCol[],
  rows: Record<string, string | number>[],
  opts: TableOptions = {},
): string {
  const head = cols
    .map((c) => {
      const isInitial = c.key === opts.initialSort
      const cls = `sortable${isInitial ? ` sort-${opts.initialDir ?? "desc"}` : ""}${c.num ? " right" : ""}`
      return `<th class="${cls}" data-sort-key="${c.key}" data-sort-type="${c.num ? "num" : "str"}">${escapeHtml(c.label)}<span class="sort-arrow"></span></th>`
    })
    .join("")
  const body = rows
    .map((r) => {
      const tds = cols
        .map((c) => {
          const raw = r[c.key]
          let display: string
          if (typeof raw === "number") {
            display = raw.toLocaleString()
          } else {
            display = String(raw ?? "")
          }
          if (opts.suffixCols && opts.suffixCols[c.key] && raw !== undefined) {
            display += opts.suffixCols[c.key]
          }
          if (c.key === opts.linkCol && typeof raw === "string" && /^https?:/.test(raw)) {
            display = `<a href="${escapeAttr(raw)}" target="_blank" rel="noreferrer">${escapeHtml(raw)}</a>`
          } else {
            display = escapeHtml(display)
          }
          const sortAttr = `data-sort-val="${escapeAttr(String(raw ?? ""))}"`
          return `<td class="${c.num ? "right" : ""}" ${sortAttr}>${display}</td>`
        })
        .join("")
      return `<tr>${tds}</tr>`
    })
    .join("")
  return `<div class="table-wrap"><table id="${id}" data-sortable><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function escapeAttr(s: string): string {
  return escapeHtml(s)
}

/**
 * Minimal markdown → HTML translator used for the narrative section in the
 * standalone export. Handles ATX headings, paragraph breaks, bold, italic,
 * inline code, and bulleted/numbered lists. Anything fancier is rendered
 * verbatim as escaped text — keeps the export bundle dependency-free.
 *
 * Inline `<svg>...</svg>` blocks (the injected YoY chart + sparkline) are
 * preserved verbatim via placeholder substitution so they don't get escaped
 * to literal text by `escapeHtml`.
 */
function markdownToBasicHtml(md: string): string {
  // GitHub-flavored slugger — same algorithm rehype-slug uses in the
  // in-app dashboard. Keeping both renderers aligned means TOC anchors
  // resolve to the same headings whether the user is viewing the live
  // dashboard or the standalone HTML export.
  const slugger = new GithubSlugger()
  const svgBlocks: string[] = []
  const placeheld = md.replace(/<svg\b[\s\S]*?<\/svg>/gi, (svg) => {
    const idx = svgBlocks.push(svg) - 1
    return ` SVG_BLOCK_${idx} `
  })
  const lines = placeheld.split("\n")
  const out: string[] = []
  let inUl = false
  let inOl = false
  let paraBuf: string[] = []
  function flushPara() {
    if (paraBuf.length === 0) return
    out.push(`<p>${inlineMd(paraBuf.join(" "))}</p>`)
    paraBuf = []
  }
  function closeLists() {
    if (inUl) {
      out.push("</ul>")
      inUl = false
    }
    if (inOl) {
      out.push("</ol>")
      inOl = false
    }
  }
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "")
    if (!line.trim()) {
      flushPara()
      closeLists()
      continue
    }
    // A line that contains only an SVG placeholder is emitted as a block
    // (not wrapped in <p>), since <svg> isn't valid phrasing content inside
    // <p> and some browsers close the <p> early when they hit it.
    const onlySvg = /^SVG_BLOCK_(\d+)$/.exec(line.trim())
    if (onlySvg) {
      flushPara()
      closeLists()
      out.push(`<div class="chart-block">${line.trim()}</div>`)
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      flushPara()
      closeLists()
      const level = Math.min(6, h[1].length)
      const headingText = h[2]
      // Strip markdown emphasis from the slug input so emphasis doesn't
      // pollute the ID. The visible heading text keeps the original markup.
      const slugSource = headingText.replace(/[*_`]/g, "").trim()
      const id = slugger.slug(slugSource)
      out.push(
        `<h${level} id="${escapeAttr(id)}">${inlineMd(headingText)}</h${level}>`,
      )
      continue
    }
    const ul = /^[-*]\s+(.*)$/.exec(line)
    if (ul) {
      flushPara()
      if (inOl) {
        out.push("</ol>")
        inOl = false
      }
      if (!inUl) {
        out.push("<ul>")
        inUl = true
      }
      out.push(`<li>${inlineMd(ul[1])}</li>`)
      continue
    }
    const ol = /^\d+\.\s+(.*)$/.exec(line)
    if (ol) {
      flushPara()
      if (inUl) {
        out.push("</ul>")
        inUl = false
      }
      if (!inOl) {
        out.push("<ol>")
        inOl = true
      }
      out.push(`<li>${inlineMd(ol[1])}</li>`)
      continue
    }
    closeLists()
    paraBuf.push(line)
  }
  flushPara()
  closeLists()
  let html = out.join("\n")
  if (svgBlocks.length > 0) {
    html = html.replace(/SVG_BLOCK_(\d+)/g, (_, idx) => svgBlocks[Number(idx)] ?? "")
  }
  return html
}

function inlineMd(s: string): string {
  // Escape first, then re-introduce the markdown markers we support.
  let out = escapeHtml(s)
  out = out.replace(/`([^`]+)`/g, '<code style="font-family:Menlo,monospace;font-size:0.95em;background:#f6f1ea;padding:0 4px;border-radius:3px">$1</code>')
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>")
  // Bare URL → link.
  out = out.replace(
    /(https?:\/\/[^\s<]+[^\s<.,;:!?])/g,
    '<a href="$1" target="_blank" rel="noreferrer">$1</a>',
  )
  return out
}

const INTERACTIVITY_JS = `
(function(){
  // Section + cluster collapse toggles.
  document.querySelectorAll('[data-section-toggle]').forEach(function(btn){
    btn.addEventListener('click', function(){
      var sec = btn.closest('.section');
      if (!sec) return;
      sec.dataset.collapsed = sec.dataset.collapsed === 'true' ? 'false' : 'true';
    });
  });
  document.querySelectorAll('[data-cluster-toggle]').forEach(function(btn){
    btn.addEventListener('click', function(){
      var c = btn.closest('.cluster');
      if (!c) return;
      c.dataset.open = c.dataset.open === 'true' ? 'false' : 'true';
    });
  });
  // Tabs.
  document.querySelectorAll('[data-tab-group]').forEach(function(group){
    var triggers = group.querySelectorAll('[data-tab-trigger]');
    var panels = group.querySelectorAll('[data-tab-panel]');
    triggers.forEach(function(t){
      t.addEventListener('click', function(){
        var key = t.getAttribute('data-tab-trigger');
        triggers.forEach(function(x){ x.classList.toggle('active', x === t); });
        panels.forEach(function(p){
          p.classList.toggle('active', p.getAttribute('data-tab-panel') === key);
        });
      });
    });
  });
  // Sortable tables.
  document.querySelectorAll('table[data-sortable]').forEach(function(tbl){
    tbl.querySelectorAll('th.sortable').forEach(function(th){
      th.addEventListener('click', function(){
        var key = th.getAttribute('data-sort-key');
        var type = th.getAttribute('data-sort-type');
        var dir = th.classList.contains('sort-asc') ? 'desc' : (th.classList.contains('sort-desc') ? 'asc' : 'desc');
        tbl.querySelectorAll('th.sortable').forEach(function(x){
          x.classList.remove('sort-asc','sort-desc');
        });
        th.classList.add('sort-' + dir);
        var idx = Array.prototype.indexOf.call(th.parentNode.children, th);
        var tbody = tbl.tBodies[0];
        var rows = Array.prototype.slice.call(tbody.rows);
        rows.sort(function(a,b){
          var av = a.cells[idx].getAttribute('data-sort-val');
          var bv = b.cells[idx].getAttribute('data-sort-val');
          if (type === 'num') {
            av = parseFloat(av); bv = parseFloat(bv);
            if (isNaN(av)) av = -Infinity;
            if (isNaN(bv)) bv = -Infinity;
            return (av - bv) * (dir === 'asc' ? 1 : -1);
          }
          return String(av).localeCompare(String(bv)) * (dir === 'asc' ? 1 : -1);
        });
        rows.forEach(function(r){ tbody.appendChild(r); });
      });
    });
  });
  // Filters.
  document.querySelectorAll('input.filter[data-filter-target]').forEach(function(inp){
    var tbl = document.getElementById(inp.getAttribute('data-filter-target'));
    if (!tbl) return;
    inp.addEventListener('input', function(){
      var q = inp.value.trim().toLowerCase();
      var rows = tbl.tBodies[0].rows;
      for (var i = 0; i < rows.length; i++) {
        var text = rows[i].innerText.toLowerCase();
        rows[i].style.display = !q || text.indexOf(q) !== -1 ? '' : 'none';
      }
    });
  });
  // TOC active state on scroll.
  var tocLinks = document.querySelectorAll('.toc a[data-toc]');
  if (tocLinks.length && 'IntersectionObserver' in window) {
    var sections = [];
    tocLinks.forEach(function(a){
      var id = a.getAttribute('href').slice(1);
      var sec = document.getElementById(id);
      if (sec) sections.push({ id: id, el: sec, link: a });
    });
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(en){
        if (en.isIntersecting) {
          tocLinks.forEach(function(l){ l.classList.remove('active'); });
          var match = sections.find(function(s){ return s.id === en.target.id; });
          if (match) match.link.classList.add('active');
        }
      });
    }, { rootMargin: '-20% 0% -70% 0%' });
    sections.forEach(function(s){ io.observe(s.el); });
  }
  // Traffic chart hover tooltip.
  document.querySelectorAll('[data-traffic-chart]').forEach(function(host){
    var tip = document.createElement('div');
    tip.className = 'tooltip';
    tip.style.display = 'none';
    host.appendChild(tip);
    host.querySelectorAll('circle[data-pt]').forEach(function(c){
      c.addEventListener('mouseenter', function(){
        try {
          var d = JSON.parse(c.getAttribute('data-pt'));
          tip.innerHTML = '<div style="font-family:Montserrat,system-ui,sans-serif;font-size:10.5px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:rgba(3,41,58,0.74)">' + d.label + '</div>'
            + '<div style="display:flex;justify-content:space-between;gap:12px;font-family:Montserrat,system-ui,sans-serif;font-variant-numeric:tabular-nums;margin-top:4px"><span>Current</span><strong>' + Number(d.current).toLocaleString() + '</strong></div>'
            + (d.prior != null ? '<div style="display:flex;justify-content:space-between;gap:12px;font-family:Montserrat,system-ui,sans-serif;font-variant-numeric:tabular-nums;color:rgba(3,41,58,0.6)"><span>Prior</span><span>' + Number(d.prior).toLocaleString() + '</span></div>' : '');
          tip.style.display = 'block';
          var rect = host.getBoundingClientRect();
          var cRect = c.getBoundingClientRect();
          tip.style.left = Math.min(rect.width - 180, cRect.left - rect.left + 12) + 'px';
          tip.style.top = (cRect.top - rect.top - 8) + 'px';
          c.setAttribute('r', '5.5');
          c.setAttribute('fill', '#FF1E00');
        } catch(e) {}
      });
      c.addEventListener('mouseleave', function(){
        tip.style.display = 'none';
        c.setAttribute('r', '3.5');
        c.setAttribute('fill', '#03293A');
      });
    });
  });
  // Smooth scroll on TOC click.
  document.querySelectorAll('.toc a[href^="#"]').forEach(function(a){
    a.addEventListener('click', function(e){
      var id = a.getAttribute('href').slice(1);
      var el = document.getElementById(id);
      if (el) {
        e.preventDefault();
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });
})();
`
