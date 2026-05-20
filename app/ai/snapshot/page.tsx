"use client"

import { useMemo, useState, type FormEvent } from "react"
import { Download, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { LocationAutocomplete } from "@/components/LocationAutocomplete"
import { ToolShell } from "@/components/tool/ToolShell"
import { ToolError, useToolRun } from "@/components/tool/use-tool-run"
import { findToolByPathname } from "@/lib/tool-config"
import { cn } from "@/lib/utils"
import type { DfsLabsLocation } from "@/lib/types"

type TopLine = {
  aiMentionRatePct: number | null
  totalMentions: number | null
  aiOverviewRatePct: number | null
  competitiveRank: { position: number; outOf: number } | null
}

type PlatformBreakdown = {
  platform: string
  mentionPct: number | null
  promptsMentioned: number
  promptsTotal: number
}

type CompetitorBar = {
  domain: string
  mentions: number
  isTarget: boolean
}

type SampleResponse = {
  prompt: string
  responseText: string
  citations: string[]
  brandCited: boolean
}

type PromptCoverageRow = {
  prompt: string
  aiSearchVolume: number | null
  platformsMentioned: Record<string, boolean>
  aiOverview: "cited" | "triggered" | "not-triggered"
}

type SourceRow = { rank: number; value: string; count: number }

type AiOverviewCard = {
  prompt: string
  brandCited: boolean
  overviewText: string
  citations: string[]
}

type Data = {
  prospect: {
    domain: string
    geo: string
    resolvedGeo: string
    promptCount: number
    llmCount: number
    runAt: string
  }
  topLine: TopLine
  competitors: CompetitorBar[]
  platformBreakdown: PlatformBreakdown[]
  sampleResponses: SampleResponse[]
  promptCoverage: PromptCoverageRow[]
  topDomains: SourceRow[]
  topPages: SourceRow[]
  aiOverviewCards: AiOverviewCard[]
  warnings: string[]
}

const PLATFORMS = ["ChatGPT", "Claude", "Gemini", "Perplexity"] as const

function formatPct(value: number | null, digits = 0): string {
  if (value == null) return "—"
  return `${value.toFixed(digits)}%`
}

function formatNumber(value: number | null): string {
  if (value == null) return "—"
  return value.toLocaleString()
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    })
  } catch {
    return iso
  }
}

function truncate(text: string, max = 280): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1).trimEnd()}…`
}

export default function AiSnapshotPage() {
  const tool = findToolByPathname("/ai/snapshot")!
  const [domain, setDomain] = useState("")
  const [geo, setGeo] = useState<DfsLabsLocation | null>(null)
  const { data, meta, loading, error, run, setError } = useToolRun<Data>(
    "/api/tools/ai/snapshot",
  )

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const d = domain.trim()
    if (!d) {
      setError("Enter a target domain.")
      return
    }
    if (!geo) {
      setError("Pick a target geo from the dropdown.")
      return
    }
    await run({
      domain: d.replace(/^https?:\/\//i, "").replace(/\/+$/, ""),
      locationCode: geo.location_code,
      locationName: geo.location_name,
    })
  }

  // LocationAutocomplete is built for multi-select; for a snapshot the user
  // picks exactly one geo, so a pick replaces whatever was selected before.
  const selectedGeo = useMemo(() => (geo ? [geo] : []), [geo])

  return (
    <ToolShell
      category="AI"
      title={tool.label}
      description={tool.description}
      endpoints={tool.endpoints}
      meta={meta}
      form={
        <form
          onSubmit={onSubmit}
          className="space-y-4"
          data-print-hide
        >
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_auto] md:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="snapshot-domain">Target domain</Label>
              <Input
                id="snapshot-domain"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="princecpagroup.com"
                disabled={loading}
              />
            </div>
            <Button type="submit" disabled={loading}>
              {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Run snapshot
            </Button>
          </div>
          <LocationAutocomplete
            inputId="snapshot-geo"
            label="Target geo"
            selected={selectedGeo}
            onAdd={(loc) => setGeo(loc)}
            onRemove={() => setGeo(null)}
            disabled={loading}
            helpText="Pick the city, state, or country to scope the SERP / AI-search-volume probes. For national B2B, pick &quot;United States.&quot;"
          />
        </form>
      }
      results={
        loading ? (
          <LoadingState />
        ) : error ? (
          <ToolError message={error} />
        ) : data ? (
          <Dashboard data={data} />
        ) : (
          <EmptyState />
        )
      }
    />
  )
}

function LoadingState() {
  return (
    <div className="rounded-md border border-dashed border-line bg-card/50 px-5 py-8 text-center">
      <Loader2 className="mx-auto h-5 w-5 animate-spin text-ink-3" />
      <p className="mt-3 font-sans text-[13px] font-semibold uppercase tracking-[0.18em] text-ink-3">
        Running snapshot…
      </p>
      <p className="mt-1 font-serif text-[13px] text-ink-3">
        Generating 25 buyer prompts, then probing ChatGPT, Claude, Gemini,
        Perplexity, and Google AI Overview. Typical run takes 30–90 seconds.
      </p>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="rounded-md border border-dashed border-line bg-card/40 px-5 py-8 text-center">
      <p className="font-sans text-[13px] font-semibold uppercase tracking-[0.18em] text-ink-3">
        Snapshot will appear here
      </p>
      <p className="mt-1 font-serif text-[13px] text-ink-3">
        Enter the prospect&apos;s domain and target geo above, then run the
        snapshot.
      </p>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────────────
// Dashboard composition.

function Dashboard({ data }: { data: Data }) {
  const brandName = useMemo(() => brandFromDomain(data.prospect.domain), [
    data.prospect.domain,
  ])

  return (
    <div className="space-y-8 ai-snapshot">
      <Header data={data} brandName={brandName} />
      <TopLineMetrics topLine={data.topLine} />
      <CompetitiveSection
        competitors={data.competitors}
        brandName={brandName}
        targetDomain={data.prospect.domain}
      />
      <PlatformGrid breakdown={data.platformBreakdown} />
      <SampleResponses
        responses={data.sampleResponses}
        targetDomain={data.prospect.domain}
      />
      <PromptCoverage rows={data.promptCoverage} />
      <SourcesSection
        topDomains={data.topDomains}
        topPages={data.topPages}
        targetDomain={data.prospect.domain}
      />
      <AiOverviewSection cards={data.aiOverviewCards} totalPrompts={data.prospect.promptCount} />
      {data.warnings.length > 0 ? (
        <Warnings warnings={data.warnings} />
      ) : null}
    </div>
  )
}

function Header({ data, brandName }: { data: Data; brandName: string }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="font-sans text-[20px] font-extrabold tracking-[-0.01em] text-foreground">
          {brandName}
        </h2>
        <p className="font-serif text-[13px] text-ink-2">
          {data.prospect.domain} · {data.prospect.resolvedGeo} ·{" "}
          {data.prospect.promptCount} prompts × {data.prospect.llmCount} LLMs ·{" "}
          {formatDate(data.prospect.runAt)}
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        onClick={() => window.print()}
        className="whitespace-nowrap print:hidden"
        data-print-hide
      >
        <Download className="mr-1.5 h-4 w-4" />
        Export PDF
      </Button>
    </header>
  )
}

function TopLineMetrics({ topLine }: { topLine: TopLine }) {
  const cards: Array<{
    label: string
    value: string
    source: string
  }> = [
    {
      label: "AI mention rate",
      value: formatPct(topLine.aiMentionRatePct),
      source: "llm_mentions_aggregated",
    },
    {
      label: "Total mentions",
      value: formatNumber(topLine.totalMentions),
      source: "llm_mentions_aggregated",
    },
    {
      label: "AI Overview rate",
      value: formatPct(topLine.aiOverviewRatePct),
      source: "serp_ai_summary",
    },
    {
      label: "Competitive rank",
      value: topLine.competitiveRank
        ? `#${topLine.competitiveRank.position} / ${topLine.competitiveRank.outOf}`
        : "—",
      source: "llm_mentions_cross",
    },
  ]
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((c) => (
        <div
          key={c.label}
          className="rounded-md border border-line bg-secondary/40 px-4 py-3 print-color-exact"
        >
          <p className="font-serif text-[13px] text-ink-2">{c.label}</p>
          <p className="font-sans text-[24px] font-semibold tabular-nums text-foreground">
            {c.value}
          </p>
          <p className="mt-1 font-mono text-[10.5px] uppercase tracking-wide text-ink-3">
            {c.source}
          </p>
        </div>
      ))}
    </div>
  )
}

function CompetitiveSection({
  competitors,
  brandName,
  targetDomain,
}: {
  competitors: CompetitorBar[]
  brandName: string
  targetDomain: string
}) {
  if (competitors.length === 0) {
    return (
      <SectionShell
        title="Share of voice across LLMs"
        endpoint="llm_mentions_cross_aggregated_metrics"
      >
        <p className="font-serif text-[13px] text-ink-3">
          No competitor mentions surfaced for this prompt set yet.
        </p>
      </SectionShell>
    )
  }
  const max = Math.max(...competitors.map((c) => c.mentions), 1)
  return (
    <SectionShell
      title="Share of voice across LLMs"
      endpoint="llm_mentions_cross_aggregated_metrics"
    >
      <div className="flex flex-col gap-2">
        {competitors.map((c) => {
          const widthPct = Math.max(2, Math.round((c.mentions / max) * 100))
          const isTarget = c.isTarget
          const label = isTarget ? brandName : domainLabel(c.domain)
          return (
            <div
              key={c.domain + (isTarget ? "·target" : "")}
              className="grid grid-cols-[160px_1fr_48px] items-center gap-3"
            >
              <span
                className={cn(
                  "truncate text-right font-sans text-[13px]",
                  isTarget ? "font-semibold text-brand-red" : "text-ink-2",
                )}
                title={
                  isTarget
                    ? `${brandName} — ${targetDomain}`
                    : c.domain
                }
              >
                {label}
              </span>
              <div className="h-5 overflow-hidden rounded-md bg-secondary/40 print-color-exact">
                <div
                  className={cn(
                    "h-full",
                    isTarget ? "bg-brand-red" : "bg-ink-3/70",
                  )}
                  style={{ width: `${widthPct}%` }}
                />
              </div>
              <span className="text-right font-mono text-[12px] tabular-nums text-ink-2">
                {c.mentions}
              </span>
            </div>
          )
        })}
      </div>
    </SectionShell>
  )
}

function PlatformGrid({ breakdown }: { breakdown: PlatformBreakdown[] }) {
  return (
    <SectionShell title="Platform breakdown" endpoint="llm_mentions_aggregated_metrics">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {breakdown.map((b) => (
          <div
            key={b.platform}
            className="rounded-md border border-line bg-secondary/40 px-4 py-3 print-color-exact"
          >
            <p className="font-serif text-[13px] text-ink-2">{b.platform}</p>
            <p className="font-sans text-[22px] font-semibold tabular-nums text-foreground">
              {formatPct(b.mentionPct)}
            </p>
            <p className="mt-1 font-serif text-[12px] text-ink-3">
              {b.promptsMentioned} of {b.promptsTotal} prompts
            </p>
          </div>
        ))}
      </div>
    </SectionShell>
  )
}

function SampleResponses({
  responses,
  targetDomain,
}: {
  responses: SampleResponse[]
  targetDomain: string
}) {
  if (responses.length === 0) {
    return (
      <SectionShell
        title="Sample ChatGPT responses"
        endpoint="chat_gpt_llm_responses_live"
      >
        <p className="font-serif text-[13px] text-ink-3">
          No sample responses returned.
        </p>
      </SectionShell>
    )
  }
  return (
    <SectionShell
      title="Sample ChatGPT responses"
      endpoint="chat_gpt_llm_responses_live"
    >
      <div className="space-y-3">
        {responses.map((r, i) => (
          <div
            key={i}
            className="rounded-md border border-line bg-secondary/40 px-4 py-3 print-color-exact"
          >
            <p className="font-sans text-[14px] font-semibold text-foreground">
              Q: {r.prompt}
            </p>
            <p className="mt-1 font-serif text-[13px] leading-relaxed text-ink-2">
              A: {truncate(r.responseText, 720)}
            </p>
            <div className="mt-2 flex flex-wrap items-baseline gap-1.5 border-t border-dashed border-line pt-2 font-mono text-[11px]">
              <span className="uppercase tracking-[0.05em] text-ink-3">
                Sources
              </span>
              {r.citations.length === 0 ? (
                <span className="text-ink-3">none returned</span>
              ) : (
                r.citations.slice(0, 6).map((cite, j) => {
                  const isBrand = cite.toLowerCase().includes(targetDomain)
                  return (
                    <span
                      key={j}
                      className={cn(
                        "rounded-md border px-1.5 py-0.5",
                        isBrand
                          ? "border-brand-red bg-brand-red/10 font-semibold text-brand-red"
                          : "border-line bg-card text-ink-2",
                      )}
                    >
                      {citationLabel(cite)}
                    </span>
                  )
                })
              )}
              {!r.brandCited ? (
                <span className="ml-auto rounded-md bg-warning-light px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-warning-dark print-color-exact">
                  Brand not cited
                </span>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </SectionShell>
  )
}

function PromptCoverage({ rows }: { rows: PromptCoverageRow[] }) {
  if (rows.length === 0) {
    return (
      <SectionShell
        title="Prompt coverage"
        endpoint="ai_keyword_data + llm_mentions_search"
      >
        <p className="font-serif text-[13px] text-ink-3">No prompts to show.</p>
      </SectionShell>
    )
  }
  return (
    <SectionShell
      title={`Prompt coverage (sample of ${rows.length})`}
      endpoint="ai_keyword_data + llm_mentions_search"
    >
      <div className="flex flex-col gap-2">
        {rows.map((row, i) => (
          <div
            key={i}
            className="rounded-md border border-line bg-secondary/40 px-4 py-3 print-color-exact"
          >
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-3">
              <p className="font-sans text-[14px] font-semibold text-foreground">
                {row.prompt}
              </p>
              <span className="font-mono text-[12px] tabular-nums text-ink-2">
                {row.aiSearchVolume == null
                  ? "—"
                  : `${row.aiSearchVolume.toLocaleString()} vol`}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {PLATFORMS.map((p) => {
                const cited = row.platformsMentioned[p]
                return (
                  <PlatformPill key={p} label={p} cited={cited} />
                )
              })}
              <AiOverviewPill state={row.aiOverview} />
            </div>
          </div>
        ))}
      </div>
    </SectionShell>
  )
}

function PlatformPill({ label, cited }: { label: string; cited: boolean }) {
  return (
    <span
      className={cn(
        "rounded-md px-2 py-0.5 font-sans text-[11px] font-semibold print-color-exact",
        cited
          ? "bg-success-light text-success-dark"
          : "bg-secondary/60 text-ink-3",
      )}
    >
      {label}
    </span>
  )
}

function AiOverviewPill({
  state,
}: {
  state: PromptCoverageRow["aiOverview"]
}) {
  if (state === "cited") {
    return (
      <span className="rounded-md bg-success-light px-2 py-0.5 font-sans text-[11px] font-semibold text-success-dark print-color-exact">
        AI Overview · cited
      </span>
    )
  }
  if (state === "triggered") {
    return (
      <span className="rounded-md bg-warning-light px-2 py-0.5 font-sans text-[11px] font-semibold text-warning-dark print-color-exact">
        AI Overview · not cited
      </span>
    )
  }
  return (
    <span className="rounded-md bg-secondary/60 px-2 py-0.5 font-sans text-[11px] font-semibold text-ink-3 print-color-exact">
      AI Overview · not triggered
    </span>
  )
}

function SourcesSection({
  topDomains,
  topPages,
  targetDomain,
}: {
  topDomains: SourceRow[]
  topPages: SourceRow[]
  targetDomain: string
}) {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <SectionShell
        title="Top cited source domains"
        endpoint="llm_mentions_top_domains"
      >
        {topDomains.length === 0 ? (
          <p className="font-serif text-[13px] text-ink-3">
            No domains cited yet.
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {topDomains.map((row) => (
              <SourceRowView
                key={row.value}
                row={row}
                highlight={row.value.toLowerCase().includes(targetDomain)}
              />
            ))}
          </div>
        )}
      </SectionShell>
      <SectionShell
        title="Top cited source pages"
        endpoint="llm_mentions_top_pages"
      >
        {topPages.length === 0 ? (
          <p className="font-serif text-[13px] text-ink-3">
            No pages cited yet.
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {topPages.map((row) => (
              <SourceRowView
                key={row.value}
                row={row}
                highlight={row.value.toLowerCase().includes(targetDomain)}
              />
            ))}
          </div>
        )}
      </SectionShell>
    </div>
  )
}

function SourceRowView({ row, highlight }: { row: SourceRow; highlight: boolean }) {
  return (
    <div
      className={cn(
        "grid grid-cols-[32px_1fr_56px] items-center gap-3 rounded-md px-3 py-1.5 print-color-exact",
        highlight ? "bg-brand-red/10" : "bg-secondary/40",
      )}
    >
      <span className="font-mono text-[12px] text-ink-3 tabular-nums">
        {row.rank.toString().padStart(2, "0")}
      </span>
      <span
        className={cn(
          "truncate font-sans text-[13px]",
          highlight ? "font-semibold text-brand-red" : "text-ink-1",
        )}
        title={row.value}
      >
        {row.value}
      </span>
      <span className="text-right font-mono text-[12px] tabular-nums text-ink-2">
        {row.count}
      </span>
    </div>
  )
}

function AiOverviewSection({
  cards,
  totalPrompts,
}: {
  cards: AiOverviewCard[]
  totalPrompts: number
}) {
  if (cards.length === 0) {
    return (
      <SectionShell title="Google AI Overview detail" endpoint="serp_ai_summary">
        <p className="font-serif text-[13px] text-ink-3">
          No Google AI Overview block surfaced for any of the {totalPrompts}{" "}
          prompts tested.
        </p>
      </SectionShell>
    )
  }
  return (
    <SectionShell title="Google AI Overview detail" endpoint="serp_ai_summary">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {cards.map((card, i) => (
          <div
            key={i}
            className="rounded-md border border-line bg-secondary/40 px-4 py-3 print-color-exact"
          >
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <p className="font-sans text-[14px] font-semibold text-foreground">
                &quot;{card.prompt}&quot;
              </p>
              <span
                className={cn(
                  "rounded-md px-2 py-0.5 font-sans text-[11px] font-semibold print-color-exact",
                  card.brandCited
                    ? "bg-success-light text-success-dark"
                    : "bg-warning-light text-warning-dark",
                )}
              >
                {card.brandCited ? "Brand cited" : "Brand not cited"}
              </span>
            </div>
            {card.overviewText ? (
              <p className="mb-2 font-serif text-[13px] leading-relaxed text-ink-2">
                {truncate(card.overviewText, 360)}
              </p>
            ) : (
              <p className="mb-2 font-serif text-[12px] italic text-ink-3">
                AI Overview triggered but DFS returned no inline text.
              </p>
            )}
            <div className="flex flex-wrap gap-1.5 font-mono text-[11px]">
              {card.citations.length === 0 ? (
                <span className="text-ink-3">no sources returned</span>
              ) : (
                card.citations.map((cite, j) => (
                  <span
                    key={j}
                    className="rounded-md border border-line bg-card px-1.5 py-0.5 text-ink-2"
                  >
                    {citationLabel(cite)}
                  </span>
                ))
              )}
            </div>
          </div>
        ))}
      </div>
    </SectionShell>
  )
}

function Warnings({ warnings }: { warnings: string[] }) {
  return (
    <div className="rounded-md border border-warning bg-warning-light/40 px-4 py-3 print-color-exact">
      <p className="font-sans text-[11px] font-bold uppercase tracking-[0.18em] text-warning-dark">
        Run notes
      </p>
      <ul className="mt-1 list-disc pl-5 font-serif text-[13px] text-warning-dark">
        {warnings.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────────────

function SectionShell({
  title,
  endpoint,
  children,
}: {
  title: string
  endpoint: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-2">
      <div className="space-y-0.5">
        <h3 className="font-sans text-[15px] font-extrabold tracking-tight text-foreground">
          {title}
        </h3>
        <p className="font-mono text-[11px] text-ink-3">{endpoint}</p>
      </div>
      {children}
    </section>
  )
}

// ───────────────────────────────────────────────────────────────────────────
// Misc UI helpers.

function citationLabel(cite: string): string {
  // The citation can be a full URL or a bare domain. Normalize for display.
  try {
    const url = new URL(cite.startsWith("http") ? cite : `https://${cite}`)
    const host = url.hostname.replace(/^www\./i, "")
    const path = url.pathname.replace(/\/$/, "")
    return path && path !== "/" ? `${host}${path}` : host
  } catch {
    return cite
  }
}

function domainLabel(domain: string): string {
  return domain.replace(/^www\./i, "")
}

function brandFromDomain(domain: string): string {
  const stem = domain
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split("/")[0]
    .split(".")[0]
  if (!stem) return domain
  return stem
    .replace(/[-_]+/g, " ")
    .split(/\s+/)
    .map((part) => (part.length <= 3 ? part.toUpperCase() : capitalize(part)))
    .join(" ")
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
