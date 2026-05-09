/**
 * CSS string embedded in the standalone HTML export. Hand-written rather
 * than extracted from Tailwind so the export stays small (well under 2 MB)
 * and renders identically across mail clients and offline browsers.
 *
 * Mirrors the Harbinger brand tokens (see design/DESIGN_NOTES.md):
 *   navy primary, cream paper, brand red as accent only, ink scale for text,
 *   warm sand lines (never cool gray).
 */
export const STANDALONE_CSS = `
*, *::before, *::after { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
  background: #faf7f2;
  color: #03293a;
  font-family: "Source Serif 4", "Source Serif Pro", Georgia, serif;
  font-size: 16px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
.tabular-nums, .num { font-variant-numeric: tabular-nums; }
h1, h2, h3, h4, h5, h6 {
  font-family: "Montserrat", "Gotham", system-ui, sans-serif;
  color: #03293a;
  margin: 0;
}
a { color: #03293a; text-decoration: underline; text-decoration-color: #cfc6b6; text-underline-offset: 2px; }
a:hover { text-decoration-color: #ff1e00; }
button { font-family: inherit; cursor: pointer; }
.container {
  max-width: 1120px;
  margin: 0 auto;
  padding: 32px 24px 64px;
}
.layout {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: 32px;
}
@media (max-width: 900px) {
  .layout { grid-template-columns: 1fr; }
}
.toc {
  position: sticky;
  top: 24px;
  align-self: start;
  max-height: calc(100vh - 48px);
  overflow-y: auto;
}
@media (max-width: 900px) {
  .toc { display: none; position: static; max-height: none; }
}
.eyebrow {
  font-family: "Montserrat", system-ui, sans-serif;
  font-weight: 800;
  font-size: 11px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: rgba(3,41,58,0.52);
  margin: 0 0 12px 0;
}
.eyebrow.red { color: #ff1e00; }
.toc ul { list-style: none; padding: 0; margin: 0; }
.toc li { margin: 0; }
.toc a {
  display: block;
  padding: 6px 12px;
  border-left: 2px solid transparent;
  border-radius: 4px;
  font-family: "Montserrat", system-ui, sans-serif;
  font-size: 12px;
  font-weight: 600;
  color: rgba(3,41,58,0.74);
  text-decoration: none;
  transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
}
.toc a:hover {
  background: rgba(3,41,58,0.04);
  color: #03293a;
}
.toc a.active {
  border-left-color: #ff1e00;
  background: rgba(255,30,0,0.06);
  color: #03293a;
}
.hero {
  background: #ffffff;
  border: 1px solid #e5ded2;
  border-radius: 14px;
  padding: 28px;
  box-shadow: 0 1px 3px rgba(3,41,58,0.06);
  margin-bottom: 24px;
}
.hero-row { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-end; justify-content: space-between; }
.hero h1 { font-size: 30px; font-weight: 900; letter-spacing: -0.01em; margin-bottom: 4px; }
.hero .meta { font-style: italic; color: rgba(3,41,58,0.74); margin: 6px 0 0 0; font-size: 14px; }
.hero .meta b { font-family: "Montserrat", system-ui, sans-serif; font-style: normal; font-weight: 800; color: #03293a; }
.btn-row { display: flex; gap: 8px; flex-wrap: wrap; }
.btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 9px 16px;
  border: 1px solid #e5ded2;
  background: #ffffff;
  color: #03293a;
  border-radius: 8px;
  font-family: "Montserrat", system-ui, sans-serif;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  text-decoration: none;
  box-shadow: 0 1px 2px rgba(3,41,58,0.04);
}
.btn-primary {
  background: #03293a;
  color: #f6f1ea;
  border-color: #03293a;
}
.warnings {
  margin-top: 20px;
  border: 1px solid rgba(199,124,0,0.4);
  background: #f7e9cc;
  color: #7a4c00;
  border-radius: 8px;
  padding: 12px 16px;
  font-size: 13px;
}
.warnings strong {
  display: block;
  font-family: "Montserrat", system-ui, sans-serif;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  margin-bottom: 4px;
}
.warnings ul { margin: 4px 0 0 18px; padding: 0; }
.section {
  background: #ffffff;
  border: 1px solid #e5ded2;
  border-radius: 14px;
  margin-bottom: 16px;
  box-shadow: 0 1px 3px rgba(3,41,58,0.06);
  overflow: hidden;
}
.section-toggle {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 24px;
  background: transparent;
  border: 0;
  text-align: left;
  cursor: pointer;
}
.section-toggle h2 {
  font-size: 19px;
  font-weight: 800;
  letter-spacing: -0.005em;
}
.section-toggle .meta {
  margin: 4px 0 0 0;
  font-style: italic;
  font-size: 13px;
  color: rgba(3,41,58,0.74);
}
.section-toggle .chev {
  flex-shrink: 0;
  transition: transform 150ms ease;
  color: rgba(3,41,58,0.52);
}
.section[data-collapsed="true"] .chev { transform: rotate(-90deg); }
.section[data-collapsed="true"] .section-body { display: none; }
.section-body {
  border-top: 1px solid #e5ded2;
  padding: 24px;
}
.overview {
  background: #ffffff;
  border: 1px solid #e5ded2;
  border-radius: 14px;
  padding: 24px;
  margin-bottom: 16px;
  box-shadow: 0 1px 3px rgba(3,41,58,0.06);
}
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 14px;
}
.kpi {
  background: rgba(250,247,242,0.7);
  border: 1px solid #e5ded2;
  border-radius: 10px;
  padding: 14px;
}
.kpi .lbl {
  font-family: "Montserrat", system-ui, sans-serif;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: rgba(3,41,58,0.52);
}
.kpi .val {
  margin-top: 6px;
  font-family: "Montserrat", system-ui, sans-serif;
  font-size: 26px;
  font-weight: 800;
  letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums;
}
.kpi .hnt {
  margin-top: 4px;
  font-style: italic;
  font-size: 12px;
  color: rgba(3,41,58,0.52);
}
ol.summary {
  list-style: none;
  margin: 0;
  padding: 0;
}
ol.summary li {
  display: flex;
  gap: 14px;
  margin: 0 0 12px 0;
  font-size: 14.5px;
  line-height: 1.6;
}
ol.summary .num {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: #03293a;
  color: #f6f1ea;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: "Montserrat", system-ui, sans-serif;
  font-size: 11px;
  font-weight: 700;
}
table { width: 100%; border-collapse: collapse; }
.table-wrap { overflow-x: auto; border: 1px solid #e5ded2; border-radius: 10px; }
thead { background: #faf7f2; }
th, td { padding: 10px 12px; }
th {
  border-bottom: 1px solid #e5ded2;
  text-align: left;
  font-family: "Montserrat", system-ui, sans-serif;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: rgba(3,41,58,0.74);
}
th.right, td.right { text-align: right; font-variant-numeric: tabular-nums; }
td { border-bottom: 1px solid rgba(229,222,210,0.7); font-size: 13.5px; }
tbody tr:nth-child(even) { background: rgba(250,247,242,0.4); }
tbody tr:last-child td { border-bottom: 0; }
th.sortable {
  cursor: pointer;
  user-select: none;
}
th.sortable:hover { color: #03293a; }
th .sort-arrow {
  display: inline-block;
  margin-left: 4px;
  width: 8px;
  text-align: center;
  opacity: 0.6;
}
th.sort-asc .sort-arrow::after { content: "▲"; opacity: 1; }
th.sort-desc .sort-arrow::after { content: "▼"; opacity: 1; }
input.filter {
  width: 100%;
  max-width: 360px;
  padding: 8px 12px;
  border: 1px solid #e5ded2;
  border-radius: 10px;
  background: #ffffff;
  font-family: inherit;
  font-size: 13.5px;
  margin-bottom: 12px;
}
input.filter:focus { outline: 0; border-color: #ff1e00; box-shadow: 0 0 0 3px rgba(255,30,0,0.18); }
.tab-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  border-bottom: 1px solid #e5ded2;
  margin-bottom: 16px;
}
.tab-strip button {
  padding: 9px 14px;
  background: transparent;
  border: 0;
  border-bottom: 2px solid transparent;
  font-family: "Montserrat", system-ui, sans-serif;
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: rgba(3,41,58,0.52);
}
.tab-strip button.active {
  color: #03293a;
  border-bottom-color: #ff1e00;
}
.tab-panel { display: none; }
.tab-panel.active { display: block; }
.cluster {
  border: 1px solid #e5ded2;
  border-radius: 10px;
  background: #ffffff;
  margin-bottom: 8px;
  overflow: hidden;
}
.cluster-toggle {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: transparent;
  border: 0;
  text-align: left;
}
.cluster .body { display: none; border-top: 1px solid #e5ded2; padding: 12px 16px; background: rgba(250,247,242,0.6); }
.cluster[data-open="true"] .body { display: block; }
.cluster[data-open="true"] .chev { transform: rotate(0deg); }
.cluster .chev { transform: rotate(-90deg); transition: transform 150ms ease; color: rgba(3,41,58,0.52); }
.badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 10px;
  border-radius: 999px;
  font-family: "Montserrat", system-ui, sans-serif;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}
.badge.success { background: #dcefe2; color: #0f5e3a; }
.badge.warning { background: #f7e9cc; color: #7a4c00; }
.badge.subject { background: rgba(255,30,0,0.15); color: #d41800; }
.channel-row {
  display: grid;
  grid-template-columns: 140px minmax(0, 1fr) 100px;
  gap: 12px;
  align-items: center;
  margin-bottom: 6px;
}
.channel-bar { height: 8px; background: #faf7f2; border-radius: 999px; overflow: hidden; }
.channel-bar > span { display: block; height: 100%; background: #03293a; }
.print-cover {
  display: none;
}
.tooltip {
  position: absolute;
  pointer-events: none;
  background: #ffffff;
  border: 1px solid #e5ded2;
  border-radius: 10px;
  padding: 8px 12px;
  font-size: 12px;
  box-shadow: 0 8px 24px -8px rgba(3,41,58,0.18);
  z-index: 10;
}
.chip-row { display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
  display: inline-flex;
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid #e5ded2;
  background: #ffffff;
  font-family: "Montserrat", system-ui, sans-serif;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: rgba(3,41,58,0.74);
}
.narrative {
  font-size: 14.5px;
  line-height: 1.65;
}
.narrative h2, .narrative h3 { margin-top: 16px; margin-bottom: 8px; }
.narrative h2 { font-size: 18px; }
.narrative h3 { font-size: 15px; }
.narrative p, .narrative ul, .narrative ol { margin: 0 0 12px 0; }
.narrative ul, .narrative ol { padding-left: 22px; }
.narrative strong { font-family: "Montserrat", system-ui, sans-serif; }

/* Internal linking section. */
.il-stats { display: grid; grid-template-columns: 180px minmax(0,1fr); gap: 16px; margin-bottom: 18px; }
.il-score { border: 1px solid rgba(3,41,58,0.16); border-radius: 8px; padding: 14px; text-align: center; background: #fff; }
.il-score-value { font-family: "Montserrat", system-ui, sans-serif; font-size: 32px; font-weight: 700; margin: 6px 0 2px; color: #03293a; }
.il-score-value span { font-size: 14px; color: rgba(3,41,58,0.5); margin-left: 2px; }
.il-score-label { font-size: 12px; color: rgba(3,41,58,0.7); }
.il-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.il-stat { border: 1px solid rgba(3,41,58,0.16); border-radius: 8px; padding: 10px 12px; background: #fff; }
.il-stat .eyebrow { margin: 0 0 4px 0; }
.il-stat p:last-child { font-family: "Montserrat", system-ui, sans-serif; font-weight: 700; font-size: 22px; color: #03293a; margin: 0; }
.il-recs { list-style: decimal; margin: 8px 0 0 0; padding-left: 20px; }
.il-rec { border: 1px solid rgba(3,41,58,0.16); border-radius: 8px; padding: 12px 14px; background: #fff; margin-bottom: 10px; }
.il-rec-title { font-family: "Montserrat", system-ui, sans-serif; font-weight: 700; color: #03293a; margin: 0 0 4px 0; }
.il-rec-detail { color: rgba(3,41,58,0.78); margin: 0 0 6px 0; font-size: 13px; }
.il-rec-urls { margin: 6px 0 0 0; padding-left: 20px; font-size: 12px; color: rgba(3,41,58,0.62); }
.il-rec-urls li { word-break: break-all; }
.il-hubs { list-style: none; padding: 0; margin: 6px 0 0 0; font-size: 12.5px; }
.il-hubs li { display: grid; grid-template-columns: 1fr 60px; gap: 12px; align-items: center; padding: 4px 0; border-bottom: 1px solid rgba(3,41,58,0.08); }
.il-hubs li:last-child { border-bottom: none; }
.il-hubs li a { word-break: break-all; }
.il-hubs li span { text-align: right; color: rgba(3,41,58,0.62); }

@media print {
  @page {
    margin: 0.75in;
    size: letter portrait;
    @bottom-center {
      content: "Harbinger Marketing — Confidential   ·   Page " counter(page) " of " counter(pages);
      font-family: Georgia, serif;
      font-style: italic;
      font-size: 9.5pt;
      color: rgba(3,41,58,0.55);
    }
  }
  html, body { background: #ffffff; font-size: 10.5pt; }
  .toc, .btn-row, .tab-strip, .filter, .sort-arrow, button.cluster-toggle .chev { display: none !important; }
  .layout { display: block; }
  .container { padding: 0; max-width: none; }
  .section { page-break-before: always; break-before: page; box-shadow: none; border: none; margin: 0 0 0.4in 0; }
  .section:first-of-type { page-break-before: auto; }
  .section-body, .cluster .body, .tab-panel { display: block !important; }
  .section[data-collapsed="true"] .section-body { display: block !important; }
  .cluster { page-break-inside: avoid; }
  .print-cover {
    display: flex !important;
    align-items: center;
    justify-content: center;
    min-height: 9in;
    text-align: center;
    page-break-after: always;
  }
  .print-cover .title { font-size: 36pt; font-weight: 900; }
  .print-cover .domain { font-style: italic; font-size: 18pt; margin: 0.25in 0 1in 0; color: rgba(3,41,58,0.74); }
  .print-cover .meta { font-family: "Montserrat", system-ui, sans-serif; font-size: 10pt; letter-spacing: 0.06em; text-transform: uppercase; }
  .hero .btn-row, .toc, button[aria-label="Open table of contents"] { display: none !important; }
}
`
