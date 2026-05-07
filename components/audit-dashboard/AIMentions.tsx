"use client"

import { useMemo, useState } from "react"
import { Section } from "./Section"
import { SortableTable, type ColumnDef } from "./SortableTable"
import type {
  AILlmDisplayRow,
  AIMentionsDisplaySection,
  AIOverviewDisplayRow,
  AIProviderSummary,
} from "@/lib/audit-dashboard-data"

/**
 * "AI Search Visibility" dashboard section. Renders three blocks:
 *
 *   1. Per-provider mention chips (ChatGPT/Perplexity/Gemini/Claude rate).
 *   2. LLM responses table — every (provider, prompt) cell, expandable
 *      to show the response snippet.
 *   3. Google AI Mode SERP table — every keyword × location probe, with
 *      cited domains and competitor highlights.
 *
 * Designed to read at a glance: the headline tells the prospect their
 * AI-search exposure in one sentence; the chips quantify per-LLM; the
 * tables provide the receipts.
 */
export function AIMentions({
  data,
}: {
  data: AIMentionsDisplaySection
}) {
  return (
    <Section
      id="ai-mentions"
      eyebrow="§ 10"
      title="AI Search Visibility"
      meta={data.headline}
    >
      <div className="space-y-6">
        {data.providerSummaries.length > 0 ? (
          <ProviderChips summaries={data.providerSummaries} />
        ) : null}

        {data.llmRows.length > 0 ? (
          <LLMResponsesTable rows={data.llmRows} brand={data.prospectBrand} />
        ) : null}

        {data.aiOverviewRows.length > 0 ? (
          <AIOverviewTable rows={data.aiOverviewRows} domain={data.prospectDomain} />
        ) : null}

        {data.topCompetitorMentions.length > 0 ? (
          <TopCompetitorMentions
            rows={data.topCompetitorMentions}
            prospectDomain={data.prospectDomain}
          />
        ) : null}

        {data.notes.length > 0 ? (
          <div className="rounded-md border border-line bg-brand-paper/40 px-4 py-3 font-serif text-[12.5px] italic text-ink-2">
            <p className="mb-1 font-sans text-[10.5px] font-bold uppercase tracking-[0.14em] not-italic text-ink-3">
              Notes
            </p>
            <ul className="list-inside list-disc space-y-0.5">
              {data.notes.map((note, i) => (
                <li key={i}>{note}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <p className="font-serif text-[12px] italic text-ink-3">
          AI Optimization API + Google AI Mode SERP probes via DataForSEO. Cost
          for this section: ${data.costUsd.toFixed(2)}.
        </p>
      </div>
    </Section>
  )
}

function ProviderChips({ summaries }: { summaries: AIProviderSummary[] }) {
  return (
    <div>
      <p className="eyebrow mb-3">Mention rate by AI assistant</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {summaries.map((s) => (
          <div
            key={s.provider}
            className="rounded-[10px] border border-line bg-brand-paper/60 p-4"
          >
            <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.16em] text-ink-3">
              {s.label}
            </p>
            <p
              className={`mt-2 font-sans text-[26px] font-extrabold leading-none tabular-nums ${
                s.mentioned > 0 ? "text-foreground" : "text-ink-3"
              }`}
            >
              {s.mentioned}
              <span className="text-[16px] font-bold text-ink-3">
                {" / "}
                {s.total}
              </span>
            </p>
            <p className="mt-1.5 font-serif text-[12.5px] italic text-ink-3">
              {s.ratePct}% of prompts mentioned the prospect
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}

function LLMResponsesTable({
  rows,
  brand,
}: {
  rows: AILlmDisplayRow[]
  brand: string
}) {
  const [openId, setOpenId] = useState<string | null>(null)
  const sorted = useMemo(
    () =>
      [...rows].sort((a, b) => {
        if (a.providerLabel !== b.providerLabel) {
          return a.providerLabel.localeCompare(b.providerLabel)
        }
        return a.promptId.localeCompare(b.promptId)
      }),
    [rows],
  )

  return (
    <div>
      <p className="eyebrow mb-3">LLM responses</p>
      <div className="overflow-hidden rounded-[10px] border border-line">
        <table className="w-full border-collapse font-sans text-[12.5px]">
          <thead className="bg-brand-paper/60 text-left text-[10.5px] font-bold uppercase tracking-[0.14em] text-ink-3">
            <tr>
              <th className="px-3 py-2 w-[110px]">Assistant</th>
              <th className="px-3 py-2">Prompt</th>
              <th className="px-3 py-2 w-[110px]">{brand} mentioned?</th>
              <th className="px-3 py-2 w-[180px]">Competitors named</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => {
              const id = `${row.provider}:${row.promptId}`
              const isOpen = openId === id
              return (
                <tr
                  key={id}
                  className="cursor-pointer border-t border-line align-top hover:bg-brand-paper/40"
                  onClick={() => setOpenId(isOpen ? null : id)}
                >
                  <td className="px-3 py-2 font-bold text-ink-2">
                    {row.providerLabel}
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-serif text-[13px] text-foreground">
                      {row.prompt}
                    </div>
                    {isOpen ? (
                      <div className="mt-2 rounded-md border border-line bg-brand-paper/60 px-3 py-2 font-serif text-[12.5px] italic text-ink-2">
                        {row.error ? (
                          <span className="text-destructive not-italic">
                            Error: {row.error}
                          </span>
                        ) : row.responseSnippet ? (
                          <>{row.responseSnippet}</>
                        ) : (
                          <span className="not-italic">
                            (Empty response — {row.citedDomainCount} cited domain
                            {row.citedDomainCount === 1 ? "" : "s"})
                          </span>
                        )}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    {row.error ? (
                      <span className="font-bold text-ink-3">—</span>
                    ) : row.mentioned ? (
                      <span className="rounded-full bg-success-light px-2.5 py-0.5 font-sans text-[11px] font-bold uppercase tracking-[0.08em] text-success-dark">
                        Yes
                      </span>
                    ) : (
                      <span className="rounded-full bg-destructive/10 px-2.5 py-0.5 font-sans text-[11px] font-bold uppercase tracking-[0.08em] text-destructive">
                        No
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-sans text-[12px] text-ink-2">
                    {row.competitorMentions.length === 0
                      ? "—"
                      : row.competitorMentions.join(", ")}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 font-serif text-[11.5px] italic text-ink-3">
        Click any row to see a snippet of the LLM&apos;s actual response.
      </p>
    </div>
  )
}

function AIOverviewTable({
  rows,
  domain,
}: {
  rows: AIOverviewDisplayRow[]
  domain: string
}) {
  const columns: ColumnDef<AIOverviewDisplayRow>[] = [
    {
      key: "keyword",
      header: "Keyword",
      cell: (r) => r.keyword,
      sortBy: (r) => r.keyword,
    },
    {
      key: "location",
      header: "Location",
      cell: (r) => r.location,
      sortBy: (r) => r.location,
      width: "w-[160px]",
    },
    {
      key: "hasAiOverview",
      header: "AI Overview",
      cell: (r) =>
        r.hasAiOverview ? (
          <span className="font-bold text-foreground">Yes</span>
        ) : (
          <span className="text-ink-3">No</span>
        ),
      sortBy: (r) => (r.hasAiOverview ? 1 : 0),
      align: "left",
      width: "w-[110px]",
    },
    {
      key: "prospectMentioned",
      header: `${domain} cited?`,
      cell: (r) =>
        r.error ? (
          <span className="font-bold text-ink-3">—</span>
        ) : r.prospectMentioned ? (
          <span className="rounded-full bg-success-light px-2.5 py-0.5 font-sans text-[11px] font-bold uppercase tracking-[0.08em] text-success-dark">
            Yes
          </span>
        ) : (
          <span className="rounded-full bg-destructive/10 px-2.5 py-0.5 font-sans text-[11px] font-bold uppercase tracking-[0.08em] text-destructive">
            No
          </span>
        ),
      sortBy: (r) => (r.prospectMentioned ? 1 : 0),
      align: "left",
      width: "w-[140px]",
    },
    {
      key: "competitorMentions",
      header: "Competitors cited",
      cell: (r) => (r.competitorMentions.length === 0 ? "—" : r.competitorMentions.join(", ")),
      sortBy: (r) => r.competitorMentions.length,
      width: "w-[200px]",
    },
    {
      key: "citedDomains",
      header: "Top cited sources",
      cell: (r) =>
        r.citedDomains.length === 0 ? "—" : r.citedDomains.join(", "),
    },
  ]

  return (
    <div>
      <p className="eyebrow mb-3">Google AI Mode results</p>
      <SortableTable
        rows={rows}
        columns={columns}
        initialSortKey="prospectMentioned"
        initialSortDir="desc"
        filterAccessor={(r) =>
          `${r.keyword} ${r.location} ${r.competitorMentions.join(" ")} ${r.citedDomains.join(" ")}`
        }
        filterPlaceholder="Filter keywords, locations, sources…"
        emptyMessage="No AI Mode probes ran for this audit."
      />
    </div>
  )
}

function TopCompetitorMentions({
  rows,
  prospectDomain,
}: {
  rows: { domain: string; count: number }[]
  prospectDomain: string
}) {
  return (
    <div>
      <p className="eyebrow mb-3">Most-cited competitors across all AI surfaces</p>
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <li
            key={r.domain}
            className="grid grid-cols-[minmax(0,1fr)_60px] items-center gap-3 rounded-md border border-line bg-brand-paper/40 px-3 py-2"
          >
            <span
              className={`truncate font-sans text-[12.5px] font-semibold ${
                r.domain === prospectDomain ? "text-foreground" : "text-ink-2"
              }`}
            >
              {r.domain}
            </span>
            <span className="text-right font-sans text-[12.5px] font-bold tabular-nums text-foreground">
              {r.count}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
