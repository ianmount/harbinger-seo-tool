"use client"

import { useMemo, useState, type FormEvent, type KeyboardEvent } from "react"
import { Download, ExternalLink, Loader2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { MarketPicker } from "@/components/tool/MarketPicker"
import { ToolShell } from "@/components/tool/ToolShell"
import { ToolError, useToolRun } from "@/components/tool/use-tool-run"
import { buildRowsWorkbook, downloadWorkbook } from "@/lib/tool-xlsx"
import { findToolByPathname } from "@/lib/tool-config"
import type { DfsLabsLocation } from "@/lib/types"
import { cn } from "@/lib/utils"

type FaqSource = { url: string; domain: string }

type RankedFaq = {
  question: string
  score: number
  frequency: number
  search_volume: number | null
  cpc: number | null
  competition_level: string | null
  intent: "I" | "N" | "C" | "T" | null
  triggered_by: string[]
  top_sources: FaqSource[]
  answer_snippets: string[]
}

type Data = {
  seeds: string[]
  location: {
    location_code: number | null
    location_name: string
    language_code: string
  }
  counts: {
    candidates_raw: number
    candidates_deduped: number
    paa_seeds: number
    paa_raw: number
    deduped_questions: number
    final_faqs: number
  }
  paa_seed_keywords: { keyword: string; search_volume: number | null }[]
  ranked: RankedFaq[]
}

const INTENT_LABEL: Record<"I" | "N" | "C" | "T", string> = {
  I: "informational",
  N: "navigational",
  C: "commercial",
  T: "transactional",
}

const INTENT_TONE: Record<"I" | "N" | "C" | "T", string> = {
  I: "bg-info-light text-info-dark",
  N: "bg-secondary text-ink-2",
  C: "bg-amber-100 text-amber-900",
  T: "bg-emerald-100 text-emerald-900",
}

export default function FaqResearchPage() {
  const tool = findToolByPathname("/keywords/faq-research")!
  const [seeds, setSeeds] = useState<string[]>([])
  const [seedDraft, setSeedDraft] = useState("")
  const [market, setMarket] = useState<DfsLabsLocation | null>(null)
  const [paaTopN, setPaaTopN] = useState<string>("30")
  const { data, meta, loading, error, run, setError } = useToolRun<Data>(
    "/api/tools/keywords/faq-research",
  )
  const [intentFilter, setIntentFilter] = useState<Set<"I" | "N" | "C" | "T">>(
    new Set(),
  )
  const [textFilter, setTextFilter] = useState("")

  function commitSeed(value: string) {
    const v = value.trim()
    if (!v) return
    setSeeds((prev) =>
      prev.some((p) => p.toLowerCase() === v.toLowerCase()) ? prev : [...prev, v],
    )
    setSeedDraft("")
  }

  function handleSeedKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault()
      commitSeed(seedDraft)
    } else if (e.key === "Backspace" && !seedDraft && seeds.length > 0) {
      setSeeds((prev) => prev.slice(0, -1))
    }
  }

  function removeSeed(idx: number) {
    setSeeds((prev) => prev.filter((_, i) => i !== idx))
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    // Accept whatever is still in the draft input so users don't have to
    // press Enter before clicking Run.
    const all = [...seeds]
    if (seedDraft.trim()) all.push(seedDraft.trim())
    const cleaned = Array.from(
      new Set(all.map((s) => s.trim()).filter(Boolean)),
    )
    if (cleaned.length === 0) {
      setError("Enter at least one seed keyword.")
      return
    }
    if (cleaned.length > 10) {
      setError("Maximum 10 seed keywords per run.")
      return
    }
    setSeeds(cleaned)
    setSeedDraft("")
    const n = Number(paaTopN)
    await run({
      seed_keywords: cleaned,
      location_code: market?.location_code,
      location_name: market ? undefined : "United States",
      language_code: "en",
      paa_top_n: Number.isFinite(n) && n > 0 ? Math.min(n, 100) : 30,
    })
  }

  function toggleIntent(letter: "I" | "N" | "C" | "T") {
    setIntentFilter((prev) => {
      const next = new Set(prev)
      if (next.has(letter)) next.delete(letter)
      else next.add(letter)
      return next
    })
  }

  const filteredRanked = useMemo(() => {
    if (!data) return [] as RankedFaq[]
    const needle = textFilter.trim().toLowerCase()
    return data.ranked.filter((r) => {
      if (intentFilter.size > 0 && (!r.intent || !intentFilter.has(r.intent))) {
        return false
      }
      if (needle && !r.question.toLowerCase().includes(needle)) return false
      return true
    })
  }, [data, intentFilter, textFilter])

  async function exportXlsx() {
    if (!data) return
    const wb = buildRowsWorkbook(
      filteredRanked,
      [
        { label: "Question", value: (r) => r.question, width: 56 },
        { label: "Score", numeric: true, value: (r) => r.score, width: 8 },
        { label: "Frequency", numeric: true, value: (r) => r.frequency, width: 10 },
        {
          label: "Search volume",
          numeric: true,
          value: (r) => r.search_volume,
          width: 14,
        },
        {
          label: "CPC",
          numeric: true,
          numFmt: "$0.00",
          value: (r) => r.cpc,
          width: 8,
        },
        {
          label: "Intent",
          value: (r) => (r.intent ? INTENT_LABEL[r.intent] : ""),
          width: 14,
        },
        {
          label: "Triggered by",
          value: (r) => r.triggered_by.join(" · "),
          width: 36,
        },
        {
          label: "Top sources",
          value: (r) => r.top_sources.map((s) => s.url).join(" | "),
          width: 60,
        },
        {
          label: "Answer snippet",
          value: (r) => r.answer_snippets[0] ?? "",
          width: 80,
        },
      ],
      "FAQ Research",
    )
    await downloadWorkbook(wb, `faq-research-${Date.now()}.xlsx`)
  }

  return (
    <ToolShell
      category="Keywords"
      title={tool.label}
      description={tool.description}
      endpoints={tool.endpoints}
      meta={meta}
      form={
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_280px]">
            <div className="space-y-1.5">
              <Label htmlFor="seed-input">Seed keywords</Label>
              <div className="flex min-h-[2.25rem] flex-wrap items-center gap-1.5 rounded-md border border-input bg-transparent px-2 py-1.5 shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
                {seeds.map((s, i) => (
                  <span
                    key={`${s}-${i}`}
                    className="inline-flex items-center gap-1 rounded-md bg-info-light px-2 py-0.5 font-mono text-[12px] text-info-dark"
                  >
                    {s}
                    <button
                      type="button"
                      onClick={() => removeSeed(i)}
                      className="text-info-dark/70 hover:text-info-dark"
                      aria-label={`Remove ${s}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
                <input
                  id="seed-input"
                  value={seedDraft}
                  onChange={(e) => setSeedDraft(e.target.value)}
                  onKeyDown={handleSeedKey}
                  onBlur={() => seedDraft && commitSeed(seedDraft)}
                  placeholder={
                    seeds.length === 0
                      ? "tankless water heater, water heater install, …"
                      : ""
                  }
                  disabled={loading}
                  className="flex-1 min-w-[160px] border-0 bg-transparent text-sm outline-none disabled:cursor-not-allowed disabled:opacity-50"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Type or paste a keyword and press Enter or comma. Up to 10 seeds
                per run.
              </p>
            </div>
            <div className="flex flex-col gap-3">
              <MarketPicker
                value={market}
                onChange={setMarket}
                label="Market"
                inputId="faq-market"
                helpText="Used for both Labs lookups and the PAA SERP scrape."
              />
              <div className="space-y-1.5">
                <Label htmlFor="paa-top-n">PAA seed count</Label>
                <Input
                  id="paa-top-n"
                  value={paaTopN}
                  onChange={(e) =>
                    setPaaTopN(e.target.value.replace(/[^\d]/g, ""))
                  }
                  inputMode="numeric"
                  placeholder="30"
                  disabled={loading}
                />
                <p className="text-xs text-muted-foreground">
                  Top-volume candidates that get SERP&apos;d for PAA (plus seeds).
                </p>
              </div>
              <Button type="submit" disabled={loading} className="mt-auto">
                {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Run FAQ research
              </Button>
            </div>
          </div>
        </form>
      }
      results={
        error ? (
          <ToolError message={error} />
        ) : loading ? (
          <PipelineLoading seedCount={seeds.length} paaTopN={Number(paaTopN) || 30} />
        ) : !data ? (
          <EmptyState />
        ) : (
          <ResultsView
            data={data}
            filtered={filteredRanked}
            intentFilter={intentFilter}
            onToggleIntent={toggleIntent}
            textFilter={textFilter}
            onTextFilter={setTextFilter}
            onExport={exportXlsx}
          />
        )
      }
    />
  )
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-dashed border-line bg-muted/30 px-6 py-10 text-center">
      <p className="font-serif text-[13.5px] text-ink-3">
        Add seed keywords above and click Run. The pipeline harvests
        question-phrase suggestions and related terms, scrapes the People Also
        Ask graph at click depth 4, clusters duplicates, and ranks the
        survivors.
      </p>
    </div>
  )
}

function PipelineLoading({
  seedCount,
  paaTopN,
}: {
  seedCount: number
  paaTopN: number
}) {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-line bg-card px-5 py-6">
        <div className="flex items-center gap-3">
          <Loader2 className="h-4 w-4 animate-spin text-ink-2" />
          <p className="font-sans text-[14px] font-medium">
            Running the FAQ pipeline…
          </p>
        </div>
        <p className="mt-2 font-mono text-[11px] text-ink-3">
          Stage 1: {seedCount * 2} Labs calls in parallel ·{" "}
          Stage 2: up to {paaTopN + seedCount} SERPs with PAA click depth 4 ·{" "}
          Stage 3: local cluster · Stage 4: keyword_overview + search_intent
        </p>
      </div>
    </div>
  )
}

function ResultsView({
  data,
  filtered,
  intentFilter,
  onToggleIntent,
  textFilter,
  onTextFilter,
  onExport,
}: {
  data: Data
  filtered: RankedFaq[]
  intentFilter: Set<"I" | "N" | "C" | "T">
  onToggleIntent: (l: "I" | "N" | "C" | "T") => void
  textFilter: string
  onTextFilter: (v: string) => void
  onExport: () => void
}) {
  return (
    <div className="space-y-4">
      <PipelineStages data={data} />
      <MetricsRow counts={data.counts} />
      <RankedList
        rows={filtered}
        total={data.ranked.length}
        intentFilter={intentFilter}
        onToggleIntent={onToggleIntent}
        textFilter={textFilter}
        onTextFilter={onTextFilter}
        onExport={onExport}
      />
    </div>
  )
}

function PipelineStages({ data }: { data: Data }) {
  const stages: {
    num: string
    title: string
    desc: string
    endpoints: string[]
    detail?: string
  }[] = [
    {
      num: "Stage 1",
      title: "Question candidate harvest",
      desc: "For each seed in parallel: pull long-tail suggestions and related keywords, filtered to question phrases with non-zero volume.",
      endpoints: [
        "dataforseo_labs_google_keyword_suggestions",
        "dataforseo_labs_google_related_keywords",
      ],
      detail: `${data.counts.candidates_raw.toLocaleString()} raw rows → ${data.counts.candidates_deduped.toLocaleString()} deduped candidates across ${data.seeds.length} seed${data.seeds.length === 1 ? "" : "s"}`,
    },
    {
      num: "Stage 2",
      title: "PAA harvest",
      desc: "Top candidates by volume + the original seeds get a SERP scrape with People Also Ask expanded to click depth 4.",
      endpoints: ["serp_organic_live_advanced"],
      detail: `${data.counts.paa_seeds.toLocaleString()} SERP calls → ${data.counts.paa_raw.toLocaleString()} raw PAA items`,
    },
    {
      num: "Stage 3",
      title: "Dedupe + cluster",
      desc: "Lowercase, strip trailing punctuation, collapse whitespace. Group near-duplicates. Track which seeds surfaced each canonical question.",
      endpoints: [],
      detail: `${data.counts.deduped_questions.toLocaleString()} canonical questions`,
    },
    {
      num: "Stage 4",
      title: "Enrich + rank",
      desc: "Batch deduped questions (chunks of 700) for volume, CPC, competition, and intent. Score = (frequency × 10) + log(volume + 1) × 5.",
      endpoints: [
        "dataforseo_labs_google_keyword_overview",
        "dataforseo_labs_search_intent",
      ],
      detail: `${data.counts.final_faqs.toLocaleString()} ranked FAQs`,
    },
  ]
  return (
    <div className="space-y-2">
      {stages.map((s, i) => (
        <div
          key={s.num}
          className="rounded-lg border border-line bg-card px-5 py-3.5"
        >
          <div className="flex items-baseline gap-2.5">
            <span className="inline-block rounded-full bg-info-light px-2.5 py-0.5 font-sans text-[11px] font-medium text-info-dark">
              {s.num}
            </span>
            <span className="font-sans text-[14px] font-medium">{s.title}</span>
            {i < stages.length - 1 ? null : null}
          </div>
          <p className="mt-1.5 text-[13px] text-ink-2">{s.desc}</p>
          {s.endpoints.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {s.endpoints.map((ep) => (
                <code
                  key={ep}
                  className="rounded-md bg-secondary px-2 py-0.5 font-mono text-[11px] text-ink-2"
                >
                  {ep}
                </code>
              ))}
            </div>
          ) : (
            <code className="mt-2 inline-block rounded-md border border-dashed border-line bg-transparent px-2 py-0.5 font-mono text-[11px] text-ink-3">
              none — local processing only
            </code>
          )}
          {s.detail ? (
            <p className="mt-2 font-mono text-[11px] text-ink-3">{s.detail}</p>
          ) : null}
        </div>
      ))}
    </div>
  )
}

function MetricsRow({ counts }: { counts: Data["counts"] }) {
  const items = [
    { label: "Question candidates", value: counts.candidates_deduped },
    { label: "PAA harvested", value: counts.paa_raw },
    { label: "Canonical questions", value: counts.deduped_questions },
    { label: "Final FAQs", value: counts.final_faqs },
  ]
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {items.map((it) => (
        <div
          key={it.label}
          className="rounded-md bg-secondary/60 px-4 py-3"
        >
          <p className="text-[12px] text-ink-2">{it.label}</p>
          <p className="mt-0.5 font-sans text-[22px] font-medium tabular-nums">
            {it.value.toLocaleString()}
          </p>
        </div>
      ))}
    </div>
  )
}

function RankedList({
  rows,
  total,
  intentFilter,
  onToggleIntent,
  textFilter,
  onTextFilter,
  onExport,
}: {
  rows: RankedFaq[]
  total: number
  intentFilter: Set<"I" | "N" | "C" | "T">
  onToggleIntent: (l: "I" | "N" | "C" | "T") => void
  textFilter: string
  onTextFilter: (v: string) => void
  onExport: () => void
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-sans text-[14px] font-medium">
          Ranked FAQ questions
        </h3>
        <Button type="button" variant="outline" size="sm" onClick={onExport}>
          <Download className="mr-1.5 h-3.5 w-3.5" />
          Export to xlsx
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[200px] max-w-[360px] flex-1">
          <Input
            value={textFilter}
            onChange={(e) => onTextFilter(e.target.value)}
            placeholder="Filter questions…"
          />
        </div>
        <span className="inline-flex items-center gap-1">
          <span className="font-mono text-[10.5px] uppercase tracking-wide text-ink-3">
            Intent
          </span>
          {(["I", "N", "C", "T"] as const).map((letter) => {
            const on = intentFilter.has(letter)
            return (
              <button
                key={letter}
                type="button"
                onClick={() => onToggleIntent(letter)}
                title={INTENT_LABEL[letter]}
                className={cn(
                  "inline-flex h-6 w-6 items-center justify-center rounded-sm font-mono text-[11px] transition-colors",
                  on
                    ? "bg-info text-white"
                    : "bg-secondary text-ink-2 hover:bg-accent",
                )}
              >
                {letter}
              </button>
            )
          })}
        </span>
        <span className="ml-auto font-mono text-[11px] text-ink-3">
          {rows.length === total
            ? `${total.toLocaleString()} rows`
            : `${rows.length.toLocaleString()} of ${total.toLocaleString()}`}
        </span>
      </div>
      <div className="flex flex-col gap-2.5">
        {rows.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line bg-muted/30 px-6 py-8 text-center font-serif text-[13px] text-ink-3">
            No questions match the current filters.
          </div>
        ) : (
          rows.map((r) => <FaqRow key={r.question} row={r} />)
        )}
      </div>
    </div>
  )
}

function FaqRow({ row }: { row: RankedFaq }) {
  return (
    <article className="rounded-lg border border-line bg-card px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="flex-1 font-sans text-[14px] font-medium">
          {row.question}
        </p>
        <span className="inline-block rounded-md bg-info-light px-2.5 py-0.5 font-mono text-[12px] font-medium text-info-dark whitespace-nowrap">
          Score {row.score}
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-3 text-[12px] text-ink-2">
        <span>
          <span className="text-ink-3">freq</span>{" "}
          <span className="tabular-nums">{row.frequency}</span>
        </span>
        <span>
          <span className="text-ink-3">vol</span>{" "}
          <span className="tabular-nums">
            {row.search_volume == null ? "—" : row.search_volume.toLocaleString()}
          </span>
        </span>
        {row.cpc != null ? (
          <span>
            <span className="text-ink-3">cpc</span>{" "}
            <span className="tabular-nums">${row.cpc.toFixed(2)}</span>
          </span>
        ) : null}
        {row.intent ? (
          <span
            className={cn(
              "inline-flex items-center rounded-sm px-1.5 py-0.5 font-mono text-[10.5px] uppercase tracking-wide",
              INTENT_TONE[row.intent],
            )}
          >
            {INTENT_LABEL[row.intent]}
          </span>
        ) : null}
      </div>
      {row.triggered_by.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <span className="font-mono text-[10.5px] uppercase tracking-wide text-ink-3">
            Triggered by
          </span>
          {row.triggered_by.slice(0, 6).map((kw) => (
            <span
              key={kw}
              className="inline-block rounded-md bg-emerald-50 px-2 py-0.5 font-mono text-[11px] text-emerald-900"
            >
              {kw}
            </span>
          ))}
          {row.triggered_by.length > 6 ? (
            <span className="font-mono text-[11px] text-ink-3">
              +{row.triggered_by.length - 6}
            </span>
          ) : null}
        </div>
      ) : null}
      {row.top_sources.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-0.5">
          {row.top_sources.map((s) => (
            <li key={s.url}>
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-mono text-[11px] text-info hover:underline"
              >
                <ExternalLink className="h-3 w-3" />
                {s.domain || s.url}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {row.answer_snippets.length > 0 ? (
        <div className="mt-2 border-t border-dashed border-line pt-2">
          <p className="font-serif text-[12.5px] leading-relaxed text-ink-2">
            {row.answer_snippets[0]}
          </p>
        </div>
      ) : null}
    </article>
  )
}
