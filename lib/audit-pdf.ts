import "server-only"
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  renderToBuffer,
} from "@react-pdf/renderer"
import React from "react"
import type { AuditSynthesis } from "@/lib/types"

/**
 * Audit PDF renderer.
 *
 * @react-pdf/renderer uses a React-like component tree to describe a PDF.
 * We render to a Buffer on the server and upload to Vercel Blob. No Chrome
 * dep, no screenshots — native rendered layout only, as per the product
 * decision logged in CLAUDE.md.
 *
 * Branding: navy primary (#0F2744), orange accent (#E87722), Helvetica
 * (React-PDF built-in). Swap to Inter later by registering the font via
 * `Font.register({ family: 'Inter', src: ... })` — requires shipping TTFs or
 * fetching from a CDN at render time; skipped for MVP.
 */

// ────────────────────────────────────────────────────────────────────────────
// Palette + typography.

const COLORS = {
  navy: "#0F2744",
  navyDark: "#07182B",
  orange: "#E87722",
  ink: "#1A1A1A",
  muted: "#6B7280",
  hairline: "#E5E7EB",
  bgSoft: "#F5F7FA",
  risk: "#B91C1C",
  success: "#065F46",
} as const

const styles = StyleSheet.create({
  page: {
    paddingHorizontal: 48,
    paddingTop: 56,
    paddingBottom: 64,
    fontSize: 10.5,
    fontFamily: "Helvetica",
    color: COLORS.ink,
    lineHeight: 1.45,
  },
  coverPage: {
    paddingHorizontal: 48,
    paddingTop: 120,
    paddingBottom: 64,
    fontFamily: "Helvetica",
    color: COLORS.ink,
    backgroundColor: COLORS.navy,
  },
  // Cover.
  coverEyebrow: {
    fontFamily: "Helvetica-Bold",
    fontSize: 11,
    letterSpacing: 2,
    color: COLORS.orange,
    textTransform: "uppercase",
  },
  coverTitle: {
    marginTop: 14,
    fontFamily: "Helvetica-Bold",
    fontSize: 34,
    color: "#FFFFFF",
    lineHeight: 1.1,
  },
  coverDomain: {
    marginTop: 22,
    fontFamily: "Helvetica-Bold",
    fontSize: 20,
    color: COLORS.orange,
  },
  coverMeta: {
    marginTop: 8,
    fontSize: 11,
    color: "#C9D3E0",
  },
  coverFooter: {
    position: "absolute",
    left: 48,
    right: 48,
    bottom: 56,
    borderTopWidth: 1,
    borderTopColor: COLORS.orange,
    paddingTop: 12,
    fontSize: 10,
    color: "#C9D3E0",
    fontFamily: "Helvetica",
  },
  coverFooterStrong: {
    fontFamily: "Helvetica-Bold",
    color: "#FFFFFF",
  },
  // Headers + body.
  sectionLabel: {
    fontFamily: "Helvetica-Bold",
    fontSize: 9.5,
    letterSpacing: 1.6,
    color: COLORS.orange,
    textTransform: "uppercase",
  },
  sectionTitle: {
    marginTop: 6,
    marginBottom: 14,
    fontFamily: "Helvetica-Bold",
    fontSize: 20,
    color: COLORS.navy,
  },
  body: { fontSize: 10.5, color: COLORS.ink, lineHeight: 1.5 },
  mutedSmall: { fontSize: 9, color: COLORS.muted },
  pageFooter: {
    position: "absolute",
    left: 48,
    right: 48,
    bottom: 28,
    fontSize: 8.5,
    color: COLORS.muted,
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: COLORS.hairline,
    paddingTop: 8,
  },
  // Findings list.
  findingRow: {
    flexDirection: "row",
    marginBottom: 14,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.hairline,
  },
  findingNumberCol: {
    width: 34,
  },
  findingNumber: {
    fontFamily: "Helvetica-Bold",
    fontSize: 22,
    color: COLORS.orange,
    lineHeight: 1,
  },
  findingBody: { flex: 1 },
  findingTitle: {
    fontFamily: "Helvetica-Bold",
    fontSize: 12,
    color: COLORS.navy,
    marginBottom: 3,
  },
  findingMetric: {
    fontFamily: "Helvetica-Bold",
    fontSize: 10.5,
    color: COLORS.ink,
    marginBottom: 3,
  },
  findingDetail: { fontSize: 10, color: COLORS.ink, lineHeight: 1.45 },
  findingImpact: {
    marginTop: 4,
    fontSize: 9.5,
    color: COLORS.muted,
    fontStyle: "italic",
  },
  executiveSummaryBox: {
    marginBottom: 18,
    padding: 14,
    backgroundColor: COLORS.bgSoft,
    borderLeftWidth: 3,
    borderLeftColor: COLORS.orange,
    fontSize: 11,
    lineHeight: 1.55,
  },
  // Traffic analysis.
  kpiRow: {
    flexDirection: "row",
    marginTop: 4,
    marginBottom: 14,
    gap: 0,
  },
  kpiCard: {
    flex: 1,
    marginRight: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: COLORS.hairline,
    borderRadius: 4,
  },
  kpiCardLast: { marginRight: 0 },
  kpiLabel: {
    fontSize: 8.5,
    color: COLORS.muted,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  kpiValue: {
    marginTop: 4,
    fontFamily: "Helvetica-Bold",
    fontSize: 18,
    color: COLORS.navy,
  },
  kpiDelta: { marginTop: 2, fontSize: 10 },
  deltaUp: { color: COLORS.success, fontFamily: "Helvetica-Bold" },
  deltaDown: { color: COLORS.risk, fontFamily: "Helvetica-Bold" },
  nuanceBox: {
    marginTop: 4,
    marginBottom: 14,
    padding: 10,
    backgroundColor: "#FFF7ED",
    borderLeftWidth: 3,
    borderLeftColor: COLORS.orange,
    fontSize: 10,
    lineHeight: 1.5,
  },
  subSectionTitle: {
    marginTop: 10,
    marginBottom: 6,
    fontFamily: "Helvetica-Bold",
    fontSize: 12,
    color: COLORS.navy,
  },
  // Table primitives — used by traffic (top pages lost) and competitive sections.
  table: {
    borderWidth: 1,
    borderColor: COLORS.hairline,
    borderRadius: 3,
    marginBottom: 12,
  },
  tableHeaderRow: {
    flexDirection: "row",
    backgroundColor: COLORS.navy,
  },
  tableHeaderCell: {
    paddingVertical: 6,
    paddingHorizontal: 8,
    fontSize: 9,
    fontFamily: "Helvetica-Bold",
    color: "#FFFFFF",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  tableRow: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderTopColor: COLORS.hairline,
  },
  tableRowProspect: { backgroundColor: "#FFF7ED" },
  tableCell: {
    paddingVertical: 6,
    paddingHorizontal: 8,
    fontSize: 9.5,
    color: COLORS.ink,
  },
  tableCellStrong: {
    paddingVertical: 6,
    paddingHorizontal: 8,
    fontSize: 9.5,
    fontFamily: "Helvetica-Bold",
    color: COLORS.navy,
  },
  narrativeBox: {
    marginTop: 6,
    padding: 10,
    backgroundColor: COLORS.bgSoft,
    fontSize: 10,
    lineHeight: 1.5,
    borderLeftWidth: 3,
    borderLeftColor: COLORS.navy,
  },
  // Technical + backlink + roadmap.
  techItem: {
    marginBottom: 10,
    paddingLeft: 10,
    borderLeftWidth: 2,
    borderLeftColor: COLORS.orange,
  },
  techTitle: {
    fontFamily: "Helvetica-Bold",
    fontSize: 11,
    color: COLORS.navy,
    marginBottom: 2,
  },
  techEvidence: {
    fontSize: 9.5,
    color: COLORS.ink,
    fontFamily: "Helvetica-Oblique",
    marginBottom: 2,
  },
  techImpact: { fontSize: 9.5, color: COLORS.ink, lineHeight: 1.45 },
  backlinkKpiRow: {
    flexDirection: "row",
    marginTop: 4,
    marginBottom: 14,
  },
  backlinkKpi: {
    flex: 1,
    marginRight: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: COLORS.hairline,
    borderRadius: 4,
  },
  backlinkKpiLast: { marginRight: 0 },
  spamChip: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 6,
    paddingVertical: 4,
    paddingHorizontal: 8,
    backgroundColor: "#FEF2F2",
    borderLeftWidth: 2,
    borderLeftColor: COLORS.risk,
  },
  spamChipDomain: {
    fontFamily: "Helvetica-Bold",
    fontSize: 10,
    color: COLORS.risk,
  },
  roadmapPhase: {
    marginBottom: 14,
    padding: 12,
    backgroundColor: COLORS.bgSoft,
    borderLeftWidth: 3,
    borderLeftColor: COLORS.navy,
  },
  roadmapPhaseHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginBottom: 4,
  },
  roadmapPhaseLabel: {
    fontFamily: "Helvetica-Bold",
    fontSize: 10,
    color: COLORS.orange,
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  roadmapTitle: {
    fontFamily: "Helvetica-Bold",
    fontSize: 13,
    color: COLORS.navy,
  },
  roadmapRefs: {
    fontSize: 9,
    color: COLORS.muted,
  },
  roadmapBody: {
    marginTop: 4,
    fontSize: 10,
    color: COLORS.ink,
    lineHeight: 1.5,
  },
  appendixList: {
    marginTop: 6,
    paddingLeft: 10,
    borderLeftWidth: 2,
    borderLeftColor: COLORS.hairline,
  },
  appendixItem: {
    fontSize: 9.5,
    color: COLORS.muted,
    marginBottom: 3,
  },
})

// ────────────────────────────────────────────────────────────────────────────
// Small helpers.

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    })
  } catch {
    return iso
  }
}

function formatDuration(seconds?: number): string | null {
  if (!seconds || seconds <= 0) return null
  const mins = Math.max(1, Math.round(seconds / 60))
  return `${mins} minute${mins === 1 ? "" : "s"}`
}

function formatCost(usd?: number): string | null {
  if (typeof usd !== "number" || usd <= 0) return null
  return `$${usd.toFixed(2)}`
}

// Stable page-footer text shared across every non-cover page.
function pageFooterText(s: AuditSynthesis): { left: string; right: string } {
  const dur = formatDuration(s.durationSeconds)
  const cost = formatCost(s.costUsd)
  const bits: string[] = []
  if (dur) bits.push(`Generated in ${dur}`)
  if (cost) bits.push(`data cost ${cost}`)
  const left = bits.length
    ? `Audit ${bits.join(" · ")} using verified first-party data.`
    : "Audit generated using verified first-party data."
  return { left, right: `Harbinger Marketing · ${s.prospectDomain}` }
}

// ────────────────────────────────────────────────────────────────────────────
// Cover page.

function CoverPage({ s }: { s: AuditSynthesis }) {
  return React.createElement(
    Page,
    { size: "LETTER", style: styles.coverPage },
    React.createElement(Text, { style: styles.coverEyebrow }, "SEO Opportunity Audit"),
    React.createElement(
      Text,
      { style: styles.coverTitle },
      "Where your organic search\nprogram stands today",
    ),
    React.createElement(Text, { style: styles.coverDomain }, s.prospectDomain),
    React.createElement(
      Text,
      { style: styles.coverMeta },
      `Prepared ${formatDate(s.generatedAt)}${s.prospectName ? ` · for ${s.prospectName}` : ""}`,
    ),
    React.createElement(
      View,
      { style: styles.coverFooter },
      React.createElement(
        Text,
        null,
        React.createElement(
          Text,
          { style: styles.coverFooterStrong },
          "Harbinger Marketing  ",
        ),
        "· prepared for your review",
      ),
    ),
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Executive summary + headline findings page.

function ExecutiveSummaryPage({ s }: { s: AuditSynthesis }) {
  const top = s.keyFindings.slice(0, 5)
  const footer = pageFooterText(s)
  return React.createElement(
    Page,
    { size: "LETTER", style: styles.page },
    React.createElement(Text, { style: styles.sectionLabel }, "Executive Summary"),
    React.createElement(
      Text,
      { style: styles.sectionTitle },
      "The 5 things that matter most",
    ),
    React.createElement(
      View,
      { style: styles.executiveSummaryBox },
      React.createElement(Text, null, s.executiveSummary),
    ),
    ...top.map((f) =>
      React.createElement(
        View,
        { key: f.number, style: styles.findingRow, wrap: false },
        React.createElement(
          View,
          { style: styles.findingNumberCol },
          React.createElement(Text, { style: styles.findingNumber }, `${f.number}.`),
        ),
        React.createElement(
          View,
          { style: styles.findingBody },
          React.createElement(Text, { style: styles.findingTitle }, f.title),
          React.createElement(Text, { style: styles.findingMetric }, f.headlineMetric),
          React.createElement(Text, { style: styles.findingDetail }, f.detail),
          f.businessImpact
            ? React.createElement(
                Text,
                { style: styles.findingImpact },
                f.businessImpact,
              )
            : null,
        ),
      ),
    ),
    React.createElement(
      View,
      { style: styles.pageFooter, fixed: true },
      React.createElement(Text, null, footer.left),
      React.createElement(Text, null, footer.right),
    ),
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Traffic analysis page (GA4 YoY). Only rendered when synthesis.trafficAnalysis
// is present — if GA4 wasn't available the whole page is skipped.

function formatNumberCompact(n: number): string {
  if (!Number.isFinite(n)) return "—"
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (Math.abs(n) >= 10_000) return `${(n / 1_000).toFixed(0)}K`
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString("en-US")
}

function formatDelta(pct: number): string {
  const sign = pct >= 0 ? "+" : ""
  return `${sign}${pct.toFixed(1)}%`
}

function TrafficPage({ s }: { s: AuditSynthesis }) {
  const t = s.trafficAnalysis
  if (!t) return null
  const footer = pageFooterText(s)

  const kpis: { label: string; value: string; delta: number }[] = [
    {
      label: "Sessions (quarter)",
      value: formatNumberCompact(t.sessionsCurrent),
      delta: t.sessionsDeltaPct,
    },
    {
      label: "Conversions",
      value: formatNumberCompact(t.conversionsCurrent),
      delta: t.conversionsDeltaPct,
    },
    {
      label: "vs. Prior Year",
      value: formatDelta(t.sessionsDeltaPct),
      delta: t.sessionsDeltaPct,
    },
  ]

  return React.createElement(
    Page,
    { size: "LETTER", style: styles.page },
    React.createElement(Text, { style: styles.sectionLabel }, "Traffic Analysis"),
    React.createElement(
      Text,
      { style: styles.sectionTitle },
      "How organic search is performing year over year",
    ),
    React.createElement(Text, { style: styles.body }, t.summary),
    React.createElement(
      View,
      { style: styles.kpiRow },
      ...kpis.map((k, i) =>
        React.createElement(
          View,
          {
            key: k.label,
            style:
              i === kpis.length - 1
                ? [styles.kpiCard, styles.kpiCardLast]
                : styles.kpiCard,
          },
          React.createElement(Text, { style: styles.kpiLabel }, k.label),
          React.createElement(Text, { style: styles.kpiValue }, k.value),
          React.createElement(
            Text,
            {
              style: [
                styles.kpiDelta,
                k.delta >= 0 ? styles.deltaUp : styles.deltaDown,
              ],
            },
            formatDelta(k.delta),
          ),
        ),
      ),
    ),
    t.nuance
      ? React.createElement(
          View,
          { style: styles.nuanceBox },
          React.createElement(Text, null, t.nuance),
        )
      : null,
    t.topPagesLost.length > 0
      ? React.createElement(
          View,
          null,
          React.createElement(
            Text,
            { style: styles.subSectionTitle },
            "Top landing pages losing organic traffic YoY",
          ),
          React.createElement(
            View,
            { style: styles.table },
            React.createElement(
              View,
              { style: styles.tableHeaderRow },
              React.createElement(
                Text,
                { style: [styles.tableHeaderCell, { flex: 5 }] },
                "Page",
              ),
              React.createElement(
                Text,
                { style: [styles.tableHeaderCell, { flex: 1.2, textAlign: "right" }] },
                "Sessions Lost",
              ),
              React.createElement(
                Text,
                { style: [styles.tableHeaderCell, { flex: 1, textAlign: "right" }] },
                "Change",
              ),
            ),
            ...t.topPagesLost.slice(0, 8).map((p, i) =>
              React.createElement(
                View,
                { key: `${p.page}-${i}`, style: styles.tableRow },
                React.createElement(
                  Text,
                  { style: [styles.tableCell, { flex: 5 }] },
                  p.page,
                ),
                React.createElement(
                  Text,
                  { style: [styles.tableCell, { flex: 1.2, textAlign: "right" }] },
                  formatNumberCompact(p.sessionsLost),
                ),
                React.createElement(
                  Text,
                  {
                    style: [
                      styles.tableCell,
                      {
                        flex: 1,
                        textAlign: "right",
                        color: p.deltaPct < 0 ? COLORS.risk : COLORS.success,
                        fontFamily: "Helvetica-Bold",
                      },
                    ],
                  },
                  formatDelta(p.deltaPct),
                ),
              ),
            ),
          ),
        )
      : null,
    s.topPagesToRecover && s.topPagesToRecover.length > 0
      ? React.createElement(
          View,
          null,
          React.createElement(
            Text,
            { style: styles.subSectionTitle },
            "Pages worth prioritizing for recovery",
          ),
          ...s.topPagesToRecover.slice(0, 5).map((p, i) =>
            React.createElement(
              View,
              {
                key: `${p.page}-${i}`,
                style: { marginBottom: 6, paddingLeft: 10 },
              },
              React.createElement(
                Text,
                { style: { fontFamily: "Helvetica-Bold", fontSize: 10 } },
                p.page,
              ),
              React.createElement(
                Text,
                { style: { fontSize: 9.5, color: COLORS.ink, lineHeight: 1.45 } },
                p.reasoning,
              ),
            ),
          ),
        )
      : null,
    React.createElement(
      View,
      { style: styles.pageFooter, fixed: true },
      React.createElement(Text, null, footer.left),
      React.createElement(Text, null, footer.right),
    ),
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Competitive keyword-visibility page. The "money shot" — a matrix of
// domain × target market with organic keyword counts and traffic estimates.

function CompetitivePage({ s }: { s: AuditSynthesis }) {
  const k = s.keywordVisibility
  const footer = pageFooterText(s)
  const markets = k.markets
  const domainColFlex = 2.2
  const marketColFlex = 1

  return React.createElement(
    Page,
    { size: "LETTER", style: styles.page },
    React.createElement(Text, { style: styles.sectionLabel }, "Keyword Visibility"),
    React.createElement(
      Text,
      { style: styles.sectionTitle },
      "How you rank against competitors, market by market",
    ),
    React.createElement(
      Text,
      { style: [styles.mutedSmall, { marginBottom: 10 }] },
      "Organic keyword counts and estimated monthly sessions from DataForSEO. Your row is highlighted.",
    ),
    React.createElement(
      View,
      { style: styles.table },
      React.createElement(
        View,
        { style: styles.tableHeaderRow },
        React.createElement(
          Text,
          { style: [styles.tableHeaderCell, { flex: domainColFlex }] },
          "Domain",
        ),
        ...markets.flatMap((m) => [
          React.createElement(
            Text,
            {
              key: `${m.city}-${m.state}-kw`,
              style: [
                styles.tableHeaderCell,
                { flex: marketColFlex, textAlign: "right" },
              ],
            },
            `${m.city} KWs`,
          ),
          React.createElement(
            Text,
            {
              key: `${m.city}-${m.state}-sess`,
              style: [
                styles.tableHeaderCell,
                { flex: marketColFlex, textAlign: "right" },
              ],
            },
            `${m.city} Sess.`,
          ),
        ]),
      ),
      ...k.rows.map((row, ri) =>
        React.createElement(
          View,
          {
            key: `${row.domain}-${ri}`,
            style: row.isProspect
              ? [styles.tableRow, styles.tableRowProspect]
              : styles.tableRow,
          },
          React.createElement(
            Text,
            {
              style: [
                row.isProspect ? styles.tableCellStrong : styles.tableCell,
                { flex: domainColFlex },
              ],
            },
            row.domain,
          ),
          ...markets.flatMap((m) => {
            const cell = row.perMarket.find(
              (pm) => pm.city === m.city && pm.state === m.state,
            )
            return [
              React.createElement(
                Text,
                {
                  key: `${row.domain}-${m.city}-kw`,
                  style: [
                    row.isProspect ? styles.tableCellStrong : styles.tableCell,
                    { flex: marketColFlex, textAlign: "right" },
                  ],
                },
                cell ? formatNumberCompact(cell.organicKeywords) : "—",
              ),
              React.createElement(
                Text,
                {
                  key: `${row.domain}-${m.city}-sess`,
                  style: [
                    row.isProspect ? styles.tableCellStrong : styles.tableCell,
                    { flex: marketColFlex, textAlign: "right" },
                  ],
                },
                cell ? formatNumberCompact(cell.organicTraffic) : "—",
              ),
            ]
          }),
        ),
      ),
    ),
    React.createElement(
      View,
      { style: styles.narrativeBox },
      React.createElement(Text, null, k.narrative),
    ),
    s.dataSources.competitorsAutoSuggested
      ? React.createElement(
          Text,
          { style: [styles.mutedSmall, { marginTop: 8 }] },
          "Competitors were auto-suggested from the top-ranking organic domains in your target markets.",
        )
      : null,
    React.createElement(
      View,
      { style: styles.pageFooter, fixed: true },
      React.createElement(Text, null, footer.left),
      React.createElement(Text, null, footer.right),
    ),
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Technical findings page — drawn from the crawl, ordered by business impact
// (not technical severity). Claude has already trimmed this to the tightest
// set; we just render.

function TechnicalPage({ s }: { s: AuditSynthesis }) {
  if (s.technicalFindings.length === 0) return null
  const footer = pageFooterText(s)
  return React.createElement(
    Page,
    { size: "LETTER", style: styles.page },
    React.createElement(Text, { style: styles.sectionLabel }, "Technical Findings"),
    React.createElement(
      Text,
      { style: styles.sectionTitle },
      "What the site crawl turned up",
    ),
    React.createElement(
      Text,
      { style: [styles.mutedSmall, { marginBottom: 10 }] },
      `Based on ${s.dataSources.crawlPagesAnalyzed} pages crawled as Googlebot-mobile.`,
    ),
    ...s.technicalFindings.slice(0, 7).map((f, i) =>
      React.createElement(
        View,
        { key: `tech-${i}`, style: styles.techItem, wrap: false },
        React.createElement(Text, { style: styles.techTitle }, f.title),
        React.createElement(Text, { style: styles.techEvidence }, f.evidence),
        React.createElement(Text, { style: styles.techImpact }, f.businessImpact),
      ),
    ),
    React.createElement(
      View,
      { style: styles.pageFooter, fixed: true },
      React.createElement(Text, null, footer.left),
      React.createElement(Text, null, footer.right),
    ),
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Backlink risk page. Specific spam domains named by name — Claude is
// prompted to lift these verbatim from the data.

function BacklinkPage({ s }: { s: AuditSynthesis }) {
  const b = s.backlinkRisk
  const footer = pageFooterText(s)
  return React.createElement(
    Page,
    { size: "LETTER", style: styles.page },
    React.createElement(Text, { style: styles.sectionLabel }, "Backlink Risk"),
    React.createElement(
      Text,
      { style: styles.sectionTitle },
      "What's linking to your site — and what shouldn't be",
    ),
    React.createElement(Text, { style: styles.body }, b.summary),
    React.createElement(
      View,
      { style: styles.backlinkKpiRow },
      React.createElement(
        View,
        { style: styles.backlinkKpi },
        React.createElement(Text, { style: styles.kpiLabel }, "Avg Spam Score"),
        React.createElement(
          Text,
          {
            style: [
              styles.kpiValue,
              { color: b.averageSpamScore >= 30 ? COLORS.risk : COLORS.navy },
            ],
          },
          `${b.averageSpamScore}`,
        ),
        React.createElement(
          Text,
          { style: { fontSize: 9, color: COLORS.muted } },
          "0–100, higher = riskier",
        ),
      ),
      React.createElement(
        View,
        { style: [styles.backlinkKpi, styles.backlinkKpiLast] },
        React.createElement(
          Text,
          { style: styles.kpiLabel },
          "High-Spam Referring Domains",
        ),
        React.createElement(
          Text,
          {
            style: [
              styles.kpiValue,
              { color: b.highSpamCount > 0 ? COLORS.risk : COLORS.navy },
            ],
          },
          formatNumberCompact(b.highSpamCount),
        ),
        React.createElement(
          Text,
          { style: { fontSize: 9, color: COLORS.muted } },
          "spam score ≥ 50",
        ),
      ),
    ),
    b.spamExamples.length > 0
      ? React.createElement(
          View,
          null,
          React.createElement(
            Text,
            { style: styles.subSectionTitle },
            "Examples of spammy referring domains",
          ),
          ...b.spamExamples.slice(0, 5).map((d) =>
            React.createElement(
              View,
              { key: d, style: styles.spamChip },
              React.createElement(Text, { style: styles.spamChipDomain }, d),
            ),
          ),
        )
      : React.createElement(
          Text,
          { style: [styles.body, { color: COLORS.success }] },
          "No high-spam referring domains surfaced in the sample — your backlink profile is clean.",
        ),
    React.createElement(
      View,
      { style: styles.pageFooter, fixed: true },
      React.createElement(Text, null, footer.left),
      React.createElement(Text, null, footer.right),
    ),
  )
}

// ────────────────────────────────────────────────────────────────────────────
// 90-day roadmap + appendix. Roadmap phases cross-reference the numbered
// findings from the executive summary. Appendix gets whatever issues didn't
// make the top 7.

function RoadmapPage({ s }: { s: AuditSynthesis }) {
  const footer = pageFooterText(s)
  const phases = s.roadmap
  const appendix = s.appendixIssues ?? []
  return React.createElement(
    Page,
    { size: "LETTER", style: styles.page },
    React.createElement(Text, { style: styles.sectionLabel }, "90-Day Roadmap"),
    React.createElement(
      Text,
      { style: styles.sectionTitle },
      "What we would do in the first quarter of engagement",
    ),
    React.createElement(
      Text,
      { style: [styles.mutedSmall, { marginBottom: 10 }] },
      "Each phase resolves specific findings from the Executive Summary.",
    ),
    ...phases.map((p, i) =>
      React.createElement(
        View,
        { key: `phase-${i}`, style: styles.roadmapPhase, wrap: false },
        React.createElement(
          View,
          { style: styles.roadmapPhaseHeader },
          React.createElement(Text, { style: styles.roadmapPhaseLabel }, p.phase),
          p.findingRefs.length > 0
            ? React.createElement(
                Text,
                { style: styles.roadmapRefs },
                `Findings ${p.findingRefs.map((n) => `#${n}`).join(", ")}`,
              )
            : null,
        ),
        React.createElement(Text, { style: styles.roadmapTitle }, p.title),
        React.createElement(Text, { style: styles.roadmapBody }, p.description),
      ),
    ),
    appendix.length > 0
      ? React.createElement(
          View,
          { style: { marginTop: 10 } },
          React.createElement(
            Text,
            { style: styles.subSectionTitle },
            "Appendix — additional issues observed",
          ),
          React.createElement(
            View,
            { style: styles.appendixList },
            ...appendix.slice(0, 20).map((item, i) =>
              React.createElement(
                Text,
                { key: `app-${i}`, style: styles.appendixItem },
                `• ${item}`,
              ),
            ),
          ),
        )
      : null,
    React.createElement(
      View,
      { style: styles.pageFooter, fixed: true },
      React.createElement(Text, null, footer.left),
      React.createElement(Text, null, footer.right),
    ),
  )
}

// ────────────────────────────────────────────────────────────────────────────
// GSC-derived sections. Only rendered when synthesis.dataSources.gscIncluded
// is true; the orchestrator is responsible for omitting these blocks from
// the synthesis when GSC was unavailable.

function pctOf(n: number): string {
  return `${(n * 100).toFixed(2)}%`
}

function PositionDistributionPage({ s }: { s: AuditSynthesis }) {
  const pd = s.positionDistribution
  if (!pd) return null
  const footer = pageFooterText(s)
  return React.createElement(
    Page,
    { size: "LETTER", style: styles.page },
    React.createElement(
      Text,
      { style: styles.sectionLabel },
      "Position Distribution",
    ),
    React.createElement(
      Text,
      { style: styles.sectionTitle },
      "How the keyword footprint splits by ranking position",
    ),
    React.createElement(Text, { style: styles.body }, pd.narrative),
    React.createElement(
      View,
      { style: [styles.table, { marginTop: 12 }] },
      React.createElement(
        View,
        { style: styles.tableHeaderRow },
        React.createElement(
          Text,
          { style: [styles.tableHeaderCell, { flex: 1.2 }] },
          "Position Band",
        ),
        React.createElement(
          Text,
          {
            style: [
              styles.tableHeaderCell,
              { flex: 1, textAlign: "right" },
            ],
          },
          "Queries",
        ),
        React.createElement(
          Text,
          {
            style: [
              styles.tableHeaderCell,
              { flex: 1.2, textAlign: "right" },
            ],
          },
          "Clicks",
        ),
        React.createElement(
          Text,
          {
            style: [
              styles.tableHeaderCell,
              { flex: 1.4, textAlign: "right" },
            ],
          },
          "Impressions",
        ),
        React.createElement(
          Text,
          { style: [styles.tableHeaderCell, { flex: 1, textAlign: "right" }] },
          "CTR",
        ),
      ),
      ...pd.bands.map((b) =>
        React.createElement(
          View,
          { key: b.band, style: styles.tableRow },
          React.createElement(
            Text,
            { style: [styles.tableCell, { flex: 1.2 }] },
            `Pos ${b.band}`,
          ),
          React.createElement(
            Text,
            {
              style: [styles.tableCell, { flex: 1, textAlign: "right" }],
            },
            b.queryCount.toLocaleString(),
          ),
          React.createElement(
            Text,
            {
              style: [styles.tableCell, { flex: 1.2, textAlign: "right" }],
            },
            b.clicks.toLocaleString(),
          ),
          React.createElement(
            Text,
            {
              style: [styles.tableCell, { flex: 1.4, textAlign: "right" }],
            },
            b.impressions.toLocaleString(),
          ),
          React.createElement(
            Text,
            {
              style: [styles.tableCell, { flex: 1, textAlign: "right" }],
            },
            pctOf(b.ctr),
          ),
        ),
      ),
    ),
    React.createElement(
      View,
      { style: styles.pageFooter, fixed: true },
      React.createElement(Text, null, footer.left),
      React.createElement(Text, null, footer.right),
    ),
  )
}

function CtrBenchmarksPage({ s }: { s: AuditSynthesis }) {
  const cb = s.observedCtrBenchmarks
  if (!cb) return null
  const footer = pageFooterText(s)
  return React.createElement(
    Page,
    { size: "LETTER", style: styles.page },
    React.createElement(
      Text,
      { style: styles.sectionLabel },
      "Calibration Baseline",
    ),
    React.createElement(
      Text,
      { style: styles.sectionTitle },
      "Your own observed click-through rates at top-3",
    ),
    React.createElement(Text, { style: styles.body }, cb.narrative),
    React.createElement(
      View,
      { style: [styles.table, { marginTop: 12 }] },
      React.createElement(
        View,
        { style: styles.tableHeaderRow },
        React.createElement(
          Text,
          { style: [styles.tableHeaderCell, { flex: 1.2 }] },
          "Impression Tier",
        ),
        React.createElement(
          Text,
          {
            style: [styles.tableHeaderCell, { flex: 1, textAlign: "right" }],
          },
          "Queries",
        ),
        React.createElement(
          Text,
          {
            style: [styles.tableHeaderCell, { flex: 1, textAlign: "right" }],
          },
          "Mean CTR",
        ),
        React.createElement(
          Text,
          {
            style: [styles.tableHeaderCell, { flex: 1, textAlign: "right" }],
          },
          "Median CTR",
        ),
        React.createElement(
          Text,
          { style: [styles.tableHeaderCell, { flex: 1.2 }] },
          "Confidence",
        ),
      ),
      ...cb.tiers.map((t) =>
        React.createElement(
          View,
          { key: t.tier, style: styles.tableRow },
          React.createElement(
            Text,
            { style: [styles.tableCell, { flex: 1.2 }] },
            t.tier,
          ),
          React.createElement(
            Text,
            { style: [styles.tableCell, { flex: 1, textAlign: "right" }] },
            t.queryCount.toLocaleString(),
          ),
          React.createElement(
            Text,
            { style: [styles.tableCell, { flex: 1, textAlign: "right" }] },
            pctOf(t.meanCtr),
          ),
          React.createElement(
            Text,
            { style: [styles.tableCell, { flex: 1, textAlign: "right" }] },
            pctOf(t.medianCtr),
          ),
          React.createElement(
            Text,
            {
              style: [
                styles.tableCell,
                { flex: 1.2, color: t.lowConfidence ? COLORS.risk : COLORS.ink },
              ],
            },
            t.lowConfidence ? "low (n<5)" : "ok",
          ),
        ),
      ),
    ),
    React.createElement(
      View,
      { style: styles.narrativeBox },
      React.createElement(
        Text,
        null,
        "These are the calibration baseline used in every uplift estimate later in this report. We deliberately do not use industry CTR averages (Backlinko, Sistrix etc.) — those studies pre-date AI Overviews and overstate CTR on high-impression queries.",
      ),
    ),
    React.createElement(
      View,
      { style: styles.pageFooter, fixed: true },
      React.createElement(Text, null, footer.left),
      React.createElement(Text, null, footer.right),
    ),
  )
}

function CtrOpportunityPage({ s }: { s: AuditSynthesis }) {
  const o = s.ctrOpportunity
  if (!o) return null
  const footer = pageFooterText(s)
  return React.createElement(
    Page,
    { size: "LETTER", style: styles.page },
    React.createElement(Text, { style: styles.sectionLabel }, "CTR Opportunity"),
    React.createElement(
      Text,
      { style: styles.sectionTitle },
      "What's recoverable if we move queries to top-3",
    ),
    React.createElement(
      View,
      { style: styles.kpiRow },
      React.createElement(
        View,
        { style: [styles.kpiCard, styles.kpiCardLast] },
        React.createElement(
          Text,
          { style: styles.kpiLabel },
          "Calibrated annual click uplift",
        ),
        React.createElement(
          Text,
          { style: styles.kpiValue },
          formatNumberCompact(o.estimatedAnnualClickUplift),
        ),
        React.createElement(
          Text,
          { style: { fontSize: 9, color: COLORS.muted } },
          `Across ${o.contributingQueryCount.toLocaleString()} queries currently at positions 4–10`,
        ),
      ),
    ),
    React.createElement(Text, { style: styles.body }, o.narrative),
    React.createElement(
      View,
      { style: styles.pageFooter, fixed: true },
      React.createElement(Text, null, footer.left),
      React.createElement(Text, null, footer.right),
    ),
  )
}

function QuickWinsPage({ s }: { s: AuditSynthesis }) {
  const q = s.quickWins
  if (!q || q.queries.length === 0) return null
  const footer = pageFooterText(s)
  return React.createElement(
    Page,
    { size: "LETTER", style: styles.page },
    React.createElement(Text, { style: styles.sectionLabel }, "Quick Wins"),
    React.createElement(
      Text,
      { style: styles.sectionTitle },
      "Queries currently at positions 4–6 worth chasing",
    ),
    React.createElement(Text, { style: styles.body }, q.narrative),
    React.createElement(
      View,
      { style: [styles.table, { marginTop: 12 }] },
      React.createElement(
        View,
        { style: styles.tableHeaderRow },
        React.createElement(
          Text,
          { style: [styles.tableHeaderCell, { flex: 3 }] },
          "Query",
        ),
        React.createElement(
          Text,
          { style: [styles.tableHeaderCell, { flex: 0.7, textAlign: "right" }] },
          "Pos",
        ),
        React.createElement(
          Text,
          { style: [styles.tableHeaderCell, { flex: 1.1, textAlign: "right" }] },
          "Impr",
        ),
        React.createElement(
          Text,
          { style: [styles.tableHeaderCell, { flex: 0.9, textAlign: "right" }] },
          "Now",
        ),
        React.createElement(
          Text,
          { style: [styles.tableHeaderCell, { flex: 0.9, textAlign: "right" }] },
          "Top-3",
        ),
        React.createElement(
          Text,
          { style: [styles.tableHeaderCell, { flex: 1.2, textAlign: "right" }] },
          "Annual ↑",
        ),
      ),
      ...q.queries.slice(0, 15).map((qw, i) =>
        React.createElement(
          View,
          { key: `qw-${i}`, style: styles.tableRow },
          React.createElement(
            Text,
            { style: [styles.tableCell, { flex: 3 }] },
            qw.query,
          ),
          React.createElement(
            Text,
            { style: [styles.tableCell, { flex: 0.7, textAlign: "right" }] },
            qw.currentPosition.toFixed(1),
          ),
          React.createElement(
            Text,
            { style: [styles.tableCell, { flex: 1.1, textAlign: "right" }] },
            formatNumberCompact(qw.currentImpressions),
          ),
          React.createElement(
            Text,
            { style: [styles.tableCell, { flex: 0.9, textAlign: "right" }] },
            pctOf(qw.currentCtr),
          ),
          React.createElement(
            Text,
            { style: [styles.tableCell, { flex: 0.9, textAlign: "right" }] },
            pctOf(qw.projectedTopThreeCtr),
          ),
          React.createElement(
            Text,
            {
              style: [
                styles.tableCell,
                {
                  flex: 1.2,
                  textAlign: "right",
                  color: COLORS.success,
                  fontFamily: "Helvetica-Bold",
                },
              ],
            },
            `+${formatNumberCompact(qw.upliftAnnualClicks)}`,
          ),
        ),
      ),
    ),
    React.createElement(
      View,
      { style: styles.pageFooter, fixed: true },
      React.createElement(Text, null, footer.left),
      React.createElement(Text, null, footer.right),
    ),
  )
}

function MegaHubsPage({ s }: { s: AuditSynthesis }) {
  const m = s.megaImpressionHubs
  if (!m || m.pages.length === 0) return null
  const footer = pageFooterText(s)
  return React.createElement(
    Page,
    { size: "LETTER", style: styles.page },
    React.createElement(
      Text,
      { style: styles.sectionLabel },
      "Mega-Impression Hubs",
    ),
    React.createElement(
      Text,
      { style: styles.sectionTitle },
      "Pages serving huge impression volume at low CTR",
    ),
    React.createElement(Text, { style: styles.body }, m.narrative),
    React.createElement(
      View,
      { style: [styles.table, { marginTop: 12 }] },
      React.createElement(
        View,
        { style: styles.tableHeaderRow },
        React.createElement(
          Text,
          { style: [styles.tableHeaderCell, { flex: 4 }] },
          "Page",
        ),
        React.createElement(
          Text,
          { style: [styles.tableHeaderCell, { flex: 1.2, textAlign: "right" }] },
          "Impr",
        ),
        React.createElement(
          Text,
          { style: [styles.tableHeaderCell, { flex: 0.9, textAlign: "right" }] },
          "Now",
        ),
        React.createElement(
          Text,
          { style: [styles.tableHeaderCell, { flex: 0.9, textAlign: "right" }] },
          "Target",
        ),
        React.createElement(
          Text,
          { style: [styles.tableHeaderCell, { flex: 1.2, textAlign: "right" }] },
          "Annual ↑",
        ),
      ),
      ...m.pages.slice(0, 10).map((h, i) =>
        React.createElement(
          View,
          { key: `mh-${i}`, style: styles.tableRow },
          React.createElement(
            Text,
            { style: [styles.tableCell, { flex: 4 }] },
            h.page,
          ),
          React.createElement(
            Text,
            { style: [styles.tableCell, { flex: 1.2, textAlign: "right" }] },
            formatNumberCompact(h.impressions),
          ),
          React.createElement(
            Text,
            { style: [styles.tableCell, { flex: 0.9, textAlign: "right" }] },
            pctOf(h.ctr),
          ),
          React.createElement(
            Text,
            { style: [styles.tableCell, { flex: 0.9, textAlign: "right" }] },
            pctOf(h.projectedCtr),
          ),
          React.createElement(
            Text,
            {
              style: [
                styles.tableCell,
                {
                  flex: 1.2,
                  textAlign: "right",
                  color: COLORS.success,
                  fontFamily: "Helvetica-Bold",
                },
              ],
            },
            `+${formatNumberCompact(h.projectedAdditionalClicks)}`,
          ),
        ),
      ),
    ),
    React.createElement(
      View,
      { style: styles.pageFooter, fixed: true },
      React.createElement(Text, null, footer.left),
      React.createElement(Text, null, footer.right),
    ),
  )
}

function PageConcentrationPage({ s }: { s: AuditSynthesis }) {
  const c = s.pageConcentration
  if (!c) return null
  const footer = pageFooterText(s)
  return React.createElement(
    Page,
    { size: "LETTER", style: styles.page },
    React.createElement(Text, { style: styles.sectionLabel }, "Page Concentration"),
    React.createElement(
      Text,
      { style: styles.sectionTitle },
      "How concentrated organic clicks are across the site",
    ),
    React.createElement(Text, { style: styles.body }, c.narrative),
    React.createElement(
      View,
      { style: [styles.table, { marginTop: 12 }] },
      React.createElement(
        View,
        { style: styles.tableHeaderRow },
        React.createElement(
          Text,
          { style: [styles.tableHeaderCell, { flex: 1 }] },
          "Top N pages",
        ),
        React.createElement(
          Text,
          { style: [styles.tableHeaderCell, { flex: 1.2, textAlign: "right" }] },
          "Clicks",
        ),
        React.createElement(
          Text,
          { style: [styles.tableHeaderCell, { flex: 1, textAlign: "right" }] },
          "Share",
        ),
      ),
      ...c.bands.map((b) =>
        React.createElement(
          View,
          { key: `pc-${b.topN}`, style: styles.tableRow },
          React.createElement(
            Text,
            { style: [styles.tableCell, { flex: 1 }] },
            `Top ${b.topN}`,
          ),
          React.createElement(
            Text,
            { style: [styles.tableCell, { flex: 1.2, textAlign: "right" }] },
            formatNumberCompact(b.clicks),
          ),
          React.createElement(
            Text,
            { style: [styles.tableCell, { flex: 1, textAlign: "right" }] },
            `${b.sharePct.toFixed(1)}%`,
          ),
        ),
      ),
    ),
    React.createElement(
      View,
      { style: styles.narrativeBox },
      React.createElement(
        Text,
        null,
        `It takes ${c.pagesToHalfOfClicks.toLocaleString()} pages to reach 50% of organic clicks. Lower numbers signal higher concentration risk.`,
      ),
    ),
    React.createElement(
      View,
      { style: styles.pageFooter, fixed: true },
      React.createElement(Text, null, footer.left),
      React.createElement(Text, null, footer.right),
    ),
  )
}

function TopicClustersPage({ s }: { s: AuditSynthesis }) {
  const tc = s.topicClusters
  if (!tc || tc.clusters.length === 0) return null
  const footer = pageFooterText(s)
  return React.createElement(
    Page,
    { size: "LETTER", style: styles.page },
    React.createElement(Text, { style: styles.sectionLabel }, "Topic Clusters"),
    React.createElement(
      Text,
      { style: styles.sectionTitle },
      "Where the keyword footprint clusters today",
    ),
    React.createElement(Text, { style: styles.body }, tc.narrative),
    React.createElement(
      View,
      { style: [styles.table, { marginTop: 12 }] },
      React.createElement(
        View,
        { style: styles.tableHeaderRow },
        React.createElement(
          Text,
          { style: [styles.tableHeaderCell, { flex: 2 }] },
          "Cluster",
        ),
        React.createElement(
          Text,
          { style: [styles.tableHeaderCell, { flex: 1, textAlign: "right" }] },
          "Queries",
        ),
        React.createElement(
          Text,
          { style: [styles.tableHeaderCell, { flex: 1, textAlign: "right" }] },
          "Clicks",
        ),
        React.createElement(
          Text,
          { style: [styles.tableHeaderCell, { flex: 1.2, textAlign: "right" }] },
          "Impr",
        ),
        React.createElement(
          Text,
          { style: [styles.tableHeaderCell, { flex: 0.9, textAlign: "right" }] },
          "CTR",
        ),
        React.createElement(
          Text,
          { style: [styles.tableHeaderCell, { flex: 0.9, textAlign: "right" }] },
          "Pos",
        ),
      ),
      ...tc.clusters.map((cl, i) =>
        React.createElement(
          View,
          {
            key: `cl-${i}`,
            style:
              cl.name === tc.highestLeverageCluster
                ? [styles.tableRow, styles.tableRowProspect]
                : styles.tableRow,
          },
          React.createElement(
            Text,
            {
              style: [
                cl.name === tc.highestLeverageCluster
                  ? styles.tableCellStrong
                  : styles.tableCell,
                { flex: 2 },
              ],
            },
            cl.name,
          ),
          React.createElement(
            Text,
            { style: [styles.tableCell, { flex: 1, textAlign: "right" }] },
            cl.queryCount.toLocaleString(),
          ),
          React.createElement(
            Text,
            { style: [styles.tableCell, { flex: 1, textAlign: "right" }] },
            formatNumberCompact(cl.totalClicks),
          ),
          React.createElement(
            Text,
            { style: [styles.tableCell, { flex: 1.2, textAlign: "right" }] },
            formatNumberCompact(cl.totalImpressions),
          ),
          React.createElement(
            Text,
            { style: [styles.tableCell, { flex: 0.9, textAlign: "right" }] },
            pctOf(cl.averageCtr),
          ),
          React.createElement(
            Text,
            { style: [styles.tableCell, { flex: 0.9, textAlign: "right" }] },
            cl.averagePosition.toFixed(1),
          ),
        ),
      ),
    ),
    React.createElement(
      View,
      { style: styles.narrativeBox },
      React.createElement(
        Text,
        null,
        `Highest-leverage cluster: ${tc.highestLeverageCluster}`,
      ),
    ),
    React.createElement(
      View,
      { style: styles.pageFooter, fixed: true },
      React.createElement(Text, null, footer.left),
      React.createElement(Text, null, footer.right),
    ),
  )
}

function LocalPerformancePage({ s }: { s: AuditSynthesis }) {
  const lp = s.localPerformance
  if (!lp || lp.rows.length === 0) return null
  const footer = pageFooterText(s)
  return React.createElement(
    Page,
    { size: "LETTER", style: styles.page },
    React.createElement(Text, { style: styles.sectionLabel }, "Local Performance"),
    React.createElement(
      Text,
      { style: styles.sectionTitle },
      "How each target market is performing",
    ),
    React.createElement(Text, { style: styles.body }, lp.narrative),
    React.createElement(
      View,
      { style: [styles.table, { marginTop: 12 }] },
      React.createElement(
        View,
        { style: styles.tableHeaderRow },
        React.createElement(
          Text,
          { style: [styles.tableHeaderCell, { flex: 2 }] },
          "Market",
        ),
        React.createElement(
          Text,
          { style: [styles.tableHeaderCell, { flex: 1, textAlign: "right" }] },
          "Rankings",
        ),
        React.createElement(
          Text,
          { style: [styles.tableHeaderCell, { flex: 1, textAlign: "right" }] },
          "Top-3",
        ),
        React.createElement(
          Text,
          { style: [styles.tableHeaderCell, { flex: 1, textAlign: "right" }] },
          "Clicks",
        ),
        React.createElement(
          Text,
          { style: [styles.tableHeaderCell, { flex: 1.2, textAlign: "right" }] },
          "Impr",
        ),
      ),
      ...lp.rows.map((r, i) =>
        React.createElement(
          View,
          { key: `lp-${i}`, style: styles.tableRow },
          React.createElement(
            Text,
            { style: [styles.tableCell, { flex: 2 }] },
            `${r.city}${r.state ? `, ${r.state}` : ""}`,
          ),
          React.createElement(
            Text,
            { style: [styles.tableCell, { flex: 1, textAlign: "right" }] },
            r.rankingsCount.toLocaleString(),
          ),
          React.createElement(
            Text,
            { style: [styles.tableCell, { flex: 1, textAlign: "right" }] },
            r.topThreeCount.toLocaleString(),
          ),
          React.createElement(
            Text,
            { style: [styles.tableCell, { flex: 1, textAlign: "right" }] },
            formatNumberCompact(r.totalClicks),
          ),
          React.createElement(
            Text,
            { style: [styles.tableCell, { flex: 1.2, textAlign: "right" }] },
            formatNumberCompact(r.totalImpressions),
          ),
        ),
      ),
    ),
    React.createElement(
      View,
      { style: styles.pageFooter, fixed: true },
      React.createElement(Text, null, footer.left),
      React.createElement(Text, null, footer.right),
    ),
  )
}

function PerformancePage({ s }: { s: AuditSynthesis }) {
  const p = s.performance
  if (!p) return null
  const footer = pageFooterText(s)

  // Combine the three risk lists into one rendered table — readers want the
  // worst-offending pages in one place rather than three small tables.
  type Row = { url: string; metric: string; value: string }
  const rows: Row[] = []
  for (const lp of p.lowScorePages) {
    rows.push({ url: lp.url, metric: "Mobile score", value: `${lp.score}/100` })
  }
  for (const lp of p.poorLcpPages) {
    rows.push({
      url: lp.url,
      metric: "Mobile LCP",
      value: `${(lp.lcpMs / 1000).toFixed(2)}s`,
    })
  }
  for (const lp of p.poorClsPages) {
    rows.push({ url: lp.url, metric: "Mobile CLS", value: lp.cls.toFixed(3) })
  }

  const summaryText = [
    p.averageMobileScore !== null
      ? `Average mobile performance: ${p.averageMobileScore}/100.`
      : null,
    p.homepageMobileScore !== null
      ? `Homepage mobile: ${p.homepageMobileScore}/100.`
      : null,
  ]
    .filter(Boolean)
    .join(" ")

  return React.createElement(
    Page,
    { size: "LETTER", style: styles.page },
    React.createElement(Text, { style: styles.sectionLabel }, "Performance"),
    React.createElement(
      Text,
      { style: styles.sectionTitle },
      "Core Web Vitals on the homepage and top GSC pages",
    ),
    React.createElement(Text, { style: styles.body }, p.narrative),
    summaryText
      ? React.createElement(
          View,
          { style: styles.narrativeBox },
          React.createElement(Text, null, summaryText),
        )
      : null,
    rows.length > 0
      ? React.createElement(
          View,
          { style: [styles.table, { marginTop: 12 }] },
          React.createElement(
            View,
            { style: styles.tableHeaderRow },
            React.createElement(
              Text,
              { style: [styles.tableHeaderCell, { flex: 5 }] },
              "Page",
            ),
            React.createElement(
              Text,
              { style: [styles.tableHeaderCell, { flex: 1.4 }] },
              "Issue",
            ),
            React.createElement(
              Text,
              { style: [styles.tableHeaderCell, { flex: 1, textAlign: "right" }] },
              "Value",
            ),
          ),
          ...rows.map((r, i) =>
            React.createElement(
              View,
              { key: `perf-${i}`, style: styles.tableRow },
              React.createElement(
                Text,
                { style: [styles.tableCell, { flex: 5 }] },
                r.url,
              ),
              React.createElement(
                Text,
                { style: [styles.tableCell, { flex: 1.4 }] },
                r.metric,
              ),
              React.createElement(
                Text,
                {
                  style: [
                    styles.tableCell,
                    { flex: 1, textAlign: "right", fontFamily: "Helvetica-Bold" },
                  ],
                },
                r.value,
              ),
            ),
          ),
        )
      : null,
    React.createElement(
      View,
      { style: styles.pageFooter, fixed: true },
      React.createElement(Text, null, footer.left),
      React.createElement(Text, null, footer.right),
    ),
  )
}

export async function renderAuditPdf(synthesis: AuditSynthesis): Promise<Buffer> {
  const doc = React.createElement(
    Document,
    {
      title: `SEO Audit — ${synthesis.prospectDomain}`,
      author: "Harbinger Marketing",
      subject: "SEO audit",
    },
    CoverPage({ s: synthesis }),
    ExecutiveSummaryPage({ s: synthesis }),
    synthesis.trafficAnalysis ? TrafficPage({ s: synthesis }) : null,
    synthesis.positionDistribution
      ? PositionDistributionPage({ s: synthesis })
      : null,
    synthesis.observedCtrBenchmarks
      ? CtrBenchmarksPage({ s: synthesis })
      : null,
    synthesis.ctrOpportunity ? CtrOpportunityPage({ s: synthesis }) : null,
    synthesis.quickWins ? QuickWinsPage({ s: synthesis }) : null,
    synthesis.megaImpressionHubs ? MegaHubsPage({ s: synthesis }) : null,
    synthesis.pageConcentration
      ? PageConcentrationPage({ s: synthesis })
      : null,
    synthesis.topicClusters ? TopicClustersPage({ s: synthesis }) : null,
    synthesis.localPerformance ? LocalPerformancePage({ s: synthesis }) : null,
    CompetitivePage({ s: synthesis }),
    TechnicalPage({ s: synthesis }),
    synthesis.performance ? PerformancePage({ s: synthesis }) : null,
    BacklinkPage({ s: synthesis }),
    RoadmapPage({ s: synthesis }),
  )
  return await renderToBuffer(doc)
}
