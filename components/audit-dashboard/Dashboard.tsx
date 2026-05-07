"use client"

import { useMemo } from "react"
import ReactMarkdown from "react-markdown"
import rehypeRaw from "rehype-raw"
import rehypeSlug from "rehype-slug"
import { AIMentions } from "./AIMentions"
import { Section } from "./Section"
import { Toc } from "./Toc"
import { SortableTable, type ColumnDef } from "./SortableTable"
import { TrafficChart } from "./TrafficChart"
import { CompetitorsTabs } from "./CompetitorsTabs"
import { CannibalizationList } from "./CannibalizationList"
import { SchemaMatrix } from "./SchemaMatrix"
import {
  type DashboardData,
  type NotIndexedRow,
  type OpportunityRow,
} from "@/lib/audit-dashboard-data"
import type { GSCTopPageRow } from "@/lib/types"

/**
 * NOTE: brand tokens are sourced from `app/globals.css` (`--color-brand-*`,
 * `--color-ink-*`). If a dedicated tokens file is introduced later (e.g.
 * `lib/design-tokens.ts`), wire it in here so this component remains the
 * single point where brand palette is consumed.
 */

export function Dashboard({
  data,
  onDownloadHtml,
  onPrint,
}: {
  data: DashboardData
  onDownloadHtml: () => void
  onPrint: () => void
}) {
  const tocItems = useMemo(() => {
    const items: { id: string; label: string }[] = [
      { id: "overview", label: "Overview" },
      { id: "executive-summary", label: "Executive Summary" },
    ]
    if (data.indexation) items.push({ id: "indexation", label: "Indexation" })
    if (data.cannibalization.clusters.length > 0)
      items.push({ id: "cannibalization", label: "Cannibalization" })
    if (data.traffic) items.push({ id: "traffic", label: "Traffic (YoY)" })
    if (data.competitors)
      items.push({ id: "competitors", label: "Competitors" })
    if (data.schema) items.push({ id: "schema", label: "Schema Coverage" })
    if (data.opportunities)
      items.push({ id: "opportunities", label: "Top Opportunities" })
    if (data.topPages) items.push({ id: "top-pages", label: "Top Pages" })
    if (data.performance) items.push({ id: "performance", label: "Site Health" })
    if (data.aiMentions)
      items.push({ id: "ai-mentions", label: "AI Search Visibility" })
    // In-narrative sections — anchor IDs match the rehype-slug output for the
    // matching ## headings emitted by buildSynthesisPrompt + Claude. Gated on
    // narrative.outline so we don't surface dead links if Claude renames or
    // omits a section.
    const outlineHas = (id: string) =>
      data.narrative.outline.some((o) => o.id === id)
    if (outlineHas("backlink-profile"))
      items.push({ id: "backlink-profile", label: "Backlinks" })
    if (outlineHas("heading-structure-h1h2"))
      items.push({ id: "heading-structure-h1h2", label: "H1/H2 Headings" })
    if (outlineHas("image-alt-text-coverage"))
      items.push({ id: "image-alt-text-coverage", label: "Alt Tags" })
    items.push({ id: "narrative", label: "Full Narrative" })
    return items
  }, [data])

  return (
    <div className="audit-dashboard">
      <PrintCover data={data} />

      <div className="grid gap-8 lg:grid-cols-[220px_minmax(0,1fr)]">
        <Toc items={tocItems} />
        <div className="space-y-6">
          <Hero data={data} onDownloadHtml={onDownloadHtml} onPrint={onPrint} />
          <Overview data={data} />
          <ExecutiveSummary data={data} />
          {data.indexation ? <Indexation data={data.indexation} /> : null}
          {data.cannibalization.clusters.length > 0 ? (
            <CannibalizationSection data={data.cannibalization} />
          ) : null}
          {data.traffic ? <TrafficSectionView data={data.traffic} /> : null}
          {data.competitors ? (
            <CompetitorsSectionView data={data.competitors} />
          ) : null}
          {data.schema ? <SchemaSectionView data={data.schema} /> : null}
          {data.opportunities ? (
            <OpportunitiesSection data={data.opportunities} />
          ) : null}
          {data.topPages ? <TopPagesSection data={data.topPages} /> : null}
          {data.performance ? (
            <PerformanceSectionView data={data.performance} />
          ) : null}
          {data.aiMentions ? <AIMentions data={data.aiMentions} /> : null}
          <NarrativeSection markdown={data.narrative.markdown} />
        </div>
      </div>

      <PrintFooter />
    </div>
  )
}

function PrintCover({ data }: { data: DashboardData }) {
  const date = data.generatedAt.slice(0, 10)
  return (
    <div className="audit-print-cover" aria-hidden>
      <div>
        <p className="audit-print-cover-eyebrow">Harbinger Marketing</p>
        <h1 className="audit-print-cover-title">SEO Audit</h1>
        <p className="audit-print-cover-domain">{data.domain}</p>
        <p className="audit-print-cover-meta">
          Prepared {date}
          <br />
          Confidential — for {data.domain} and Harbinger Marketing
        </p>
      </div>
    </div>
  )
}

function PrintFooter() {
  return <div className="audit-print-footer" aria-hidden />
}

function Hero({
  data,
  onDownloadHtml,
  onPrint,
}: {
  data: DashboardData
  onDownloadHtml: () => void
  onPrint: () => void
}) {
  const date = data.generatedAt.slice(0, 10)
  return (
    <header className="rounded-[14px] border border-line bg-card p-6 shadow-card">
      <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="eyebrow eyebrow-red">SEO Audit</p>
          <h1 className="mt-1.5 font-sans text-[28px] font-extrabold tracking-[-0.01em] text-foreground sm:text-[32px]">
            {data.domain}
          </h1>
          <p className="mt-1.5 font-serif text-[14px] italic text-ink-2">
            Audit prepared {date} · Generated in{" "}
            <b className="font-sans font-extrabold not-italic text-foreground">
              {data.durationMinutes}
            </b>{" "}
            minute{data.durationMinutes === 1 ? "" : "s"} · Prepared by{" "}
            <b className="font-sans font-extrabold not-italic text-foreground">
              Harbinger Marketing
            </b>
          </p>
        </div>
        <div className="flex flex-wrap gap-2" data-print-hide>
          <button
            type="button"
            onClick={onDownloadHtml}
            className="inline-flex items-center gap-2 rounded-md border border-line bg-card px-4 py-2 font-sans text-[11.5px] font-bold uppercase tracking-[0.08em] text-foreground shadow-sm transition-colors hover:bg-brand-paper"
          >
            Download as HTML
          </button>
          <button
            type="button"
            onClick={onPrint}
            className="inline-flex items-center gap-2 rounded-md bg-brand-navy px-4 py-2 font-sans text-[11.5px] font-bold uppercase tracking-[0.08em] text-brand-cream shadow-sm transition-colors hover:bg-brand-navy-700"
          >
            Download as PDF
          </button>
        </div>
      </div>
      {data.warnings.length > 0 ? (
        <div
          role="status"
          className="mt-5 rounded-md border border-warning/40 bg-warning-light px-4 py-3 font-serif text-[13px] text-warning-dark"
        >
          <strong className="font-sans text-[11px] font-bold uppercase tracking-[0.16em]">
            Warnings ({data.warnings.length})
          </strong>
          <ul className="mt-1.5 list-inside list-disc space-y-0.5">
            {data.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </header>
  )
}

function Overview({ data }: { data: DashboardData }) {
  return (
    <section
      id="overview"
      data-section
      className="scroll-mt-28 rounded-[14px] border border-line bg-card p-6 shadow-card"
    >
      <p className="eyebrow eyebrow-red mb-3">Overview</p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {data.summary.map((item, i) => (
          <div
            key={i}
            className="rounded-[10px] border border-line bg-brand-paper/60 p-4"
          >
            <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.16em] text-ink-3">
              {item.label}
            </p>
            <p className="mt-2 font-sans text-[26px] font-extrabold leading-none tracking-[-0.01em] tabular-nums text-foreground">
              {item.value}
            </p>
            {item.hint ? (
              <p className="mt-1.5 font-serif text-[12.5px] italic text-ink-3">
                {item.hint}
              </p>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  )
}

function ExecutiveSummary({ data }: { data: DashboardData }) {
  const { headline, bullets } = data.executiveSummary
  return (
    <Section
      id="executive-summary"
      eyebrow="§ 01"
      title="Executive Summary"
      meta={headline}
    >
      {bullets.length === 0 ? (
        <p className="font-serif text-[13.5px] italic text-ink-2">
          No summary bullets parsed from the synthesis.
        </p>
      ) : (
        <ol className="space-y-3">
          {bullets.map((b, i) => (
            <li key={i} className="flex gap-3">
              <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-navy font-sans text-[11px] font-bold text-brand-cream">
                {i + 1}
              </span>
              <p className="font-serif text-[14.5px] leading-relaxed text-foreground">
                {b}
              </p>
            </li>
          ))}
        </ol>
      )}
    </Section>
  )
}

function Indexation({
  data,
}: {
  data: NonNullable<DashboardData["indexation"]>
}) {
  const columns: ColumnDef<NotIndexedRow>[] = [
    {
      key: "pattern",
      header: "URL Pattern",
      cell: (r) => (
        <span className="font-sans text-[12px] font-semibold text-ink-2">
          {r.pattern}
        </span>
      ),
      sortBy: (r) => r.pattern,
      width: "w-[180px]",
    },
    {
      key: "url",
      header: "URL",
      cell: (r) => (
        <a
          href={r.url}
          target="_blank"
          rel="noreferrer"
          className="break-all underline decoration-line decoration-1 underline-offset-2 hover:decoration-brand-red"
        >
          {r.url}
        </a>
      ),
      sortBy: (r) => r.url,
    },
    {
      key: "lastCrawl",
      header: "Last Crawl",
      cell: (r) => r.lastCrawl ?? "—",
      sortBy: (r) => r.lastCrawl ?? "",
      width: "w-[120px]",
    },
    {
      key: "coverageState",
      header: "Coverage",
      cell: (r) => r.coverageState ?? "—",
      width: "w-[180px]",
    },
  ]
  return (
    <Section
      id="indexation"
      eyebrow="§ 02"
      title="Indexation Status"
      meta={`${data.indexedCount} of ${data.sitemapCount} sitemap URLs received impressions in the 90-day window.`}
    >
      <SortableTable
        rows={data.notIndexed}
        columns={columns}
        initialSortKey="pattern"
        initialSortDir="asc"
        filterAccessor={(r) => `${r.url} ${r.pattern} ${r.coverageState ?? ""}`}
        filterPlaceholder="Filter URLs (pattern, coverage state)…"
        emptyMessage="Every sitemap URL received impressions in the window."
        caption={
          data.hasInspectionData
            ? "Inspected sample shows last-crawl + coverage state when available."
            : "URL Inspection sample was not available for this property."
        }
      />
    </Section>
  )
}

function CannibalizationSection({
  data,
}: {
  data: DashboardData["cannibalization"]
}) {
  return (
    <Section
      id="cannibalization"
      eyebrow="§ 03"
      title="Keyword Cannibalization"
      meta="Pages competing with each other for the same query, title, or URL pattern."
    >
      <CannibalizationList data={data} />
    </Section>
  )
}

function TrafficSectionView({
  data,
}: {
  data: NonNullable<DashboardData["traffic"]>
}) {
  const delta = data.sessionsDeltaPct
  const deltaLabel =
    delta == null
      ? "No prior-year data"
      : `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}% YoY`
  return (
    <Section
      id="traffic"
      eyebrow="§ 04"
      title="Organic Traffic — Year over Year"
      meta={`${data.sessionsCurrent.toLocaleString()} sessions in last 12 months · ${deltaLabel}`}
    >
      <div className="space-y-6">
        <TrafficChart series={data.series} />
        {data.channels.length > 0 ? (
          <div>
            <p className="eyebrow mb-3">Channel mix · last 12 months</p>
            <ul className="space-y-1.5">
              {data.channels.map((c) => (
                <li
                  key={c.channel}
                  className="grid grid-cols-[140px_minmax(0,1fr)_80px] items-center gap-3"
                >
                  <span className="truncate font-sans text-[12px] font-semibold text-foreground">
                    {c.channel}
                  </span>
                  <span className="block h-2 overflow-hidden rounded-full bg-brand-paper">
                    <span
                      className="block h-full bg-brand-navy"
                      style={{ width: `${Math.min(100, c.sharePct)}%` }}
                      aria-hidden
                    />
                  </span>
                  <span className="text-right font-sans tabular-nums text-[12.5px] text-ink-2">
                    {c.sessions.toLocaleString()} ·{" "}
                    {c.sharePct.toFixed(1)}%
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Section>
  )
}

function CompetitorsSectionView({
  data,
}: {
  data: NonNullable<DashboardData["competitors"]>
}) {
  return (
    <Section
      id="competitors"
      eyebrow="§ 05"
      title="Competitor Snapshot by Location"
      meta={`${data.locations.length} location${data.locations.length === 1 ? "" : "s"} surveyed.`}
    >
      <CompetitorsTabs data={data} />
    </Section>
  )
}

function SchemaSectionView({
  data,
}: {
  data: NonNullable<DashboardData["schema"]>
}) {
  return (
    <Section
      id="schema"
      eyebrow="§ 06"
      title="Schema Coverage"
      meta="Click a row to see what's needed to close the gap."
    >
      <SchemaMatrix data={data} />
    </Section>
  )
}

function OpportunitiesSection({
  data,
}: {
  data: NonNullable<DashboardData["opportunities"]>
}) {
  const columns: ColumnDef<OpportunityRow>[] = [
    {
      key: "query",
      header: "Query",
      cell: (r) => r.query,
      sortBy: (r) => r.query,
    },
    {
      key: "impressions",
      header: "Impressions",
      cell: (r) => r.impressions.toLocaleString(),
      sortBy: (r) => r.impressions,
      align: "right",
      width: "w-[120px]",
    },
    {
      key: "clicks",
      header: "Clicks",
      cell: (r) => r.clicks.toLocaleString(),
      sortBy: (r) => r.clicks,
      align: "right",
      width: "w-[100px]",
    },
    {
      key: "position",
      header: "Position",
      cell: (r) => r.position.toFixed(1),
      sortBy: (r) => r.position,
      align: "right",
      width: "w-[110px]",
    },
    {
      key: "ctr",
      header: "CTR",
      cell: (r) => `${(r.ctr * 100).toFixed(1)}%`,
      sortBy: (r) => r.ctr,
      align: "right",
      width: "w-[90px]",
    },
    {
      key: "estimatedClickLift",
      header: "Est Lift",
      cell: (r) => r.estimatedClickLift.toLocaleString(),
      sortBy: (r) => r.estimatedClickLift,
      align: "right",
      width: "w-[110px]",
    },
  ]
  return (
    <Section
      id="opportunities"
      eyebrow="§ 07"
      title="Top Opportunities"
      meta="Queries ranking 3–25 with impression volume worth pursuing. Lift assumes a top-3 CTR of 18%."
    >
      <SortableTable
        rows={data.rows}
        columns={columns}
        initialSortKey="estimatedClickLift"
        initialSortDir="desc"
        filterAccessor={(r) => r.query}
        filterPlaceholder="Filter queries…"
      />
    </Section>
  )
}

function TopPagesSection({
  data,
}: {
  data: NonNullable<DashboardData["topPages"]>
}) {
  const columns: ColumnDef<GSCTopPageRow>[] = [
    {
      key: "page",
      header: "Page",
      cell: (r) => (
        <a
          href={r.page}
          target="_blank"
          rel="noreferrer"
          className="break-all underline decoration-line decoration-1 underline-offset-2 hover:decoration-brand-red"
        >
          {r.page}
        </a>
      ),
      sortBy: (r) => r.page,
    },
    {
      key: "clicks",
      header: "Clicks",
      cell: (r) => r.clicks.toLocaleString(),
      sortBy: (r) => r.clicks,
      align: "right",
      width: "w-[110px]",
    },
    {
      key: "impressions",
      header: "Impressions",
      cell: (r) => r.impressions.toLocaleString(),
      sortBy: (r) => r.impressions,
      align: "right",
      width: "w-[130px]",
    },
    {
      key: "position",
      header: "Position",
      cell: (r) => r.position.toFixed(1),
      sortBy: (r) => r.position,
      align: "right",
      width: "w-[110px]",
    },
  ]
  return (
    <Section
      id="top-pages"
      eyebrow="§ 08"
      title="Top Landing Pages"
      meta="Highest-traffic pages over the 16-month window."
    >
      <SortableTable
        rows={data.rows}
        columns={columns}
        initialSortKey="clicks"
        initialSortDir="desc"
        filterAccessor={(r) => r.page}
        filterPlaceholder="Filter pages…"
      />
    </Section>
  )
}

function PerformanceSectionView({
  data,
}: {
  data: NonNullable<DashboardData["performance"]>
}) {
  const stats: { label: string; value: string }[] = [
    { label: "Pages crawled", value: data.pagesAnalyzed.toLocaleString() },
    { label: "Missing titles", value: data.missingTitles.toLocaleString() },
    {
      label: "Missing descriptions",
      value: data.missingDescriptions.toLocaleString(),
    },
    {
      label: "Duplicate titles",
      value: data.duplicateTitles.toLocaleString(),
    },
    {
      label: "Duplicate descriptions",
      value: data.duplicateDescriptions.toLocaleString(),
    },
    { label: "Thin content pages", value: data.thinContentPages.toLocaleString() },
    { label: "SPA shell pages", value: data.spaShellPages.toLocaleString() },
  ]
  return (
    <Section
      id="performance"
      eyebrow="§ 09"
      title="Site Health"
      meta="On-page issues surfaced by the crawl."
    >
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {stats.map((s) => (
          <li
            key={s.label}
            className="flex items-baseline justify-between rounded-[10px] border border-line bg-brand-paper/40 px-4 py-3"
          >
            <span className="font-sans text-[11.5px] font-bold uppercase tracking-[0.14em] text-ink-2">
              {s.label}
            </span>
            <span className="font-sans text-[18px] font-extrabold tabular-nums text-foreground">
              {s.value}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  )
}

function NarrativeSection({ markdown }: { markdown: string }) {
  return (
    <Section
      id="narrative"
      eyebrow="§ 11"
      title="Full Audit Narrative"
      meta="Claude's full synthesis — supports the structured sections above."
      defaultOpen
    >
      <article className="prose prose-sm max-w-none prose-headings:font-sans prose-headings:font-extrabold prose-headings:tracking-[-0.005em] prose-h1:text-[22px] prose-h2:text-[18px] prose-h3:text-[14.5px] prose-headings:scroll-mt-28 prose-strong:text-foreground prose-a:text-foreground prose-a:underline prose-a:decoration-line">
        <ReactMarkdown rehypePlugins={[rehypeRaw, rehypeSlug]}>
          {markdown}
        </ReactMarkdown>
      </article>
    </Section>
  )
}
