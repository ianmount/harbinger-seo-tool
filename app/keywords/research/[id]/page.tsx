"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useParams } from "next/navigation"
import Link from "next/link"
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Download,
  Loader2,
  Plus,
  RefreshCw,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import type {
  JobProgress,
} from "@/lib/jobs"
import type {
  KeywordCandidate,
  KeywordResearchRun,
} from "@/lib/types"

const POLL_MS = 3000

function fmt(n: number | null | undefined): string {
  return n == null ? "—" : n.toLocaleString()
}

export default function KeywordResearchWorkspace() {
  const params = useParams<{ id: string }>()
  const id = params.id

  const [run, setRun] = useState<KeywordResearchRun | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [jobProgress, setJobProgress] = useState<JobProgress | null>(null)

  const fetchRun = useCallback(async () => {
    try {
      const res = await fetch(`/api/keywords/research/runs/${id}`)
      if (!res.ok) {
        setLoadError(res.status === 404 ? "Run not found." : `Error ${res.status}`)
        return null
      }
      const data = await res.json()
      setRun(data.run as KeywordResearchRun)
      return data.run as KeywordResearchRun
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load run.")
      return null
    }
  }, [id])

  // Initial load. setState happens after the awaited fetch (inside fetchRun),
  // not synchronously — this is data-fetch-on-mount, not a render cascade.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchRun()
  }, [fetchRun])

  // Poll while in a transient state.
  const status = run?.status
  useEffect(() => {
    if (status !== "generating" && status !== "localizing") return
    const t = setInterval(() => {
      fetchRun()
    }, POLL_MS)
    return () => clearInterval(t)
  }, [status, fetchRun])

  // Pull job progress while localizing.
  const jobId = run?.jobId
  useEffect(() => {
    if (status !== "localizing" || !jobId) return
    let active = true
    const poll = () => {
      fetch(`/api/jobs/${jobId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (active && d?.job?.progress) setJobProgress(d.job.progress)
        })
        .catch(() => {})
    }
    poll()
    const t = setInterval(poll, POLL_MS)
    return () => {
      active = false
      clearInterval(t)
    }
  }, [status, jobId])

  if (loadError) {
    return (
      <div className="space-y-4">
        <BackLink />
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
          {loadError}
        </div>
      </div>
    )
  }
  if (!run) {
    return (
      <div className="flex items-center gap-2 text-ink-3">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <BackLink />
      <header className="space-y-1">
        <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink-3">
          Keyword Research
        </p>
        <h1 className="font-sans text-[22px] font-extrabold tracking-[-0.015em] text-foreground">
          {run.domain}
        </h1>
        <p className="font-mono text-[11px] text-ink-3">
          {run.locations.map((l) => l.label).join(" · ")}
        </p>
      </header>

      {actionError ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          {actionError}
        </div>
      ) : null}

      {run.status === "seeds_review" ? (
        <SeedsReview
          run={run}
          busy={busy}
          onRunUpdate={setRun}
          onError={setActionError}
          onSubmit={async (seeds) => {
            setBusy(true)
            setActionError(null)
            try {
              const res = await fetch(
                `/api/keywords/research/runs/${id}/seeds`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ seeds }),
                },
              )
              const data = await res.json()
              if (!res.ok) {
                setActionError(data.error ?? `Error ${res.status}`)
                await fetchRun()
                return
              }
              setRun(data.run as KeywordResearchRun)
            } catch (err) {
              setActionError(err instanceof Error ? err.message : "Failed.")
            } finally {
              setBusy(false)
            }
          }}
        />
      ) : null}

      {run.status === "generating" ? (
        <Spinner text="Generating candidates and curating… this runs a couple of DataForSEO calls per seed, give it a moment." />
      ) : null}

      {run.status === "keywords_review" ? (
        <KeywordsReview
          run={run}
          busy={busy}
          onSubmit={async (keywords) => {
            setBusy(true)
            setActionError(null)
            try {
              const res = await fetch(
                `/api/keywords/research/runs/${id}/localize`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ keywords }),
                },
              )
              const data = await res.json()
              if (!res.ok) {
                setActionError(data.error ?? `Error ${res.status}`)
                return
              }
              setRun(data.run as KeywordResearchRun)
            } catch (err) {
              setActionError(err instanceof Error ? err.message : "Failed.")
            } finally {
              setBusy(false)
            }
          }}
        />
      ) : null}

      {run.status === "localizing" ? (
        <Spinner
          text={
            jobProgress?.stage
              ? `${jobProgress.stage}${jobProgress.detail ? ` — ${jobProgress.detail}` : ""}`
              : "Running city volume + SERP rank in the background. You can leave this page and come back — the run will be here."
          }
        />
      ) : null}

      {run.status === "completed" && run.result ? (
        <Results run={run} />
      ) : null}

      {run.status === "failed" ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
          <p className="font-medium">This run failed.</p>
          <p className="mt-1 font-mono text-[12px]">{run.error ?? "Unknown error."}</p>
        </div>
      ) : null}

      {run.status === "cancelled" ? (
        <div className="rounded-md border border-line bg-muted/30 px-4 py-3 text-[13px] text-ink-2">
          This run was cancelled.
        </div>
      ) : null}
    </div>
  )
}

function BackLink() {
  return (
    <Link
      href="/keywords/research"
      className="inline-flex items-center gap-1 text-[12px] text-ink-2 hover:text-foreground"
    >
      <ArrowLeft className="h-3.5 w-3.5" /> All runs
    </Link>
  )
}

function Spinner({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line bg-card px-5 py-6">
      <Loader2 className="h-5 w-5 animate-spin text-ink-2" />
      <p className="text-[13.5px] text-ink-2">{text}</p>
    </div>
  )
}

// ── Checkpoint 1: seeds ──────────────────────────────────────────────────────

function SeedsReview({
  run,
  busy,
  onSubmit,
  onRunUpdate,
  onError,
}: {
  run: KeywordResearchRun
  busy: boolean
  onSubmit: (seeds: string[]) => void
  onRunUpdate: (run: KeywordResearchRun) => void
  onError: (msg: string | null) => void
}) {
  const proposal = useMemo(() => run.seedProposal ?? [], [run.seedProposal])
  const allSeeds = useMemo(
    () => proposal.flatMap((g) => g.seeds.map((s) => s.seed)),
    [proposal],
  )
  const seedsKey = useMemo(
    () => allSeeds.join("|").toLowerCase(),
    [allSeeds],
  )
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(allSeeds.map((s) => s.toLowerCase())),
  )
  const [custom, setCustom] = useState<string[]>([])
  const [draft, setDraft] = useState("")
  const [instructions, setInstructions] = useState("")
  const [regenerating, setRegenerating] = useState(false)

  // When the proposal changes (e.g. after a regeneration), re-check all of
  // the new seeds so the user starts from "all selected" again.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setChecked(new Set(seedsKey ? seedsKey.split("|") : []))
  }, [seedsKey])

  async function regenerate() {
    if (!instructions.trim()) return
    setRegenerating(true)
    onError(null)
    try {
      const res = await fetch(
        `/api/keywords/research/runs/${run.id}/regenerate-seeds`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ instructions: instructions.trim() }),
        },
      )
      const data = await res.json()
      if (!res.ok) {
        onError(data.error ?? `Error ${res.status}`)
        return
      }
      onRunUpdate(data.run as KeywordResearchRun)
    } catch (err) {
      onError(err instanceof Error ? err.message : "Regeneration failed.")
    } finally {
      setRegenerating(false)
    }
  }

  function toggle(seed: string) {
    setChecked((prev) => {
      const next = new Set(prev)
      const k = seed.toLowerCase()
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }

  function addCustom() {
    const v = draft.trim()
    if (!v) return
    const k = v.toLowerCase()
    if (
      !custom.some((c) => c.toLowerCase() === k) &&
      !allSeeds.some((s) => s.toLowerCase() === k)
    ) {
      setCustom((c) => [...c, v])
    }
    setDraft("")
  }

  const finalSeeds = [
    ...allSeeds.filter((s) => checked.has(s.toLowerCase())),
    ...custom,
  ]

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-line bg-card px-5 py-4">
        <p className="text-[13.5px] font-medium text-foreground">
          Step 1 · Approve seeds
        </p>
        <p className="mt-1 text-[13px] text-ink-2">
          Claude proposed these seeds from your services, with rough national
          volume as evidence. Uncheck any that are off, add your own, then
          generate candidates. (Nothing paid runs until the next step.)
        </p>
      </div>

      {proposal.map((group) => (
        <div
          key={group.service}
          className="rounded-lg border border-line bg-card px-5 py-4"
        >
          <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink-3">
            {group.service}
          </p>
          <div className="mt-2 space-y-1.5">
            {group.seeds.map((s) => (
              <label
                key={s.seed}
                className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-1 hover:bg-muted/40"
              >
                <span className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={checked.has(s.seed.toLowerCase())}
                    onChange={() => toggle(s.seed)}
                  />
                  <span className="text-[13.5px] text-foreground">{s.seed}</span>
                </span>
                <span className="font-mono text-[11px] text-ink-3">
                  {s.nationalVolume == null
                    ? "no vol"
                    : `${s.nationalVolume.toLocaleString()}/mo`}
                </span>
              </label>
            ))}
          </div>
        </div>
      ))}

      <div className="rounded-lg border border-line bg-card px-5 py-4">
        <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink-3">
          Add your own seeds
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {custom.map((c) => (
            <span
              key={c}
              className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-0.5 text-[12px]"
            >
              {c}
              <button
                type="button"
                onClick={() => setCustom((arr) => arr.filter((x) => x !== c))}
                aria-label={`Remove ${c}`}
                className="text-ink-3 hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                addCustom()
              }
            }}
            onBlur={addCustom}
            placeholder="extra seed, press Enter"
            className="h-8 w-56"
          />
        </div>
      </div>

      <div className="rounded-lg border border-line bg-card px-5 py-4">
        <p className="font-sans text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink-3">
          Ask Claude to revise the seeds
        </p>
        <p className="mt-1 text-[12.5px] text-ink-2">
          Not quite right? Tell Claude what to change and regenerate the whole
          list — e.g. &ldquo;focus on emergency/repair intent&rdquo;, &ldquo;add
          commercial/B2B terms&rdquo;, &ldquo;drop anything about installation&rdquo;.
        </p>
        <Textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="Revision instructions for Claude…"
          rows={3}
          className="mt-2"
          disabled={regenerating || busy}
        />
        <div className="mt-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={regenerating || busy || !instructions.trim()}
            onClick={regenerate}
          >
            {regenerating ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            Regenerate seeds
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button
          disabled={busy || regenerating || finalSeeds.length === 0}
          onClick={() => onSubmit(finalSeeds)}
        >
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
          Generate candidates ({finalSeeds.length} seed{finalSeeds.length === 1 ? "" : "s"})
        </Button>
      </div>
    </div>
  )
}

// ── Checkpoint 2: keywords ───────────────────────────────────────────────────

function KeywordsReview({
  run,
  busy,
  onSubmit,
}: {
  run: KeywordResearchRun
  busy: boolean
  onSubmit: (keywords: string[]) => void
}) {
  const prospect = useMemo(() => run.prospect ?? [], [run.prospect])
  const drops = run.drops ?? []
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(prospect.map((c) => c.keyword.toLowerCase())),
  )
  const [showDrops, setShowDrops] = useState(false)
  const [filter, setFilter] = useState("")

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return prospect
    return prospect.filter(
      (c) =>
        c.keyword.toLowerCase().includes(needle) ||
        c.seed.toLowerCase().includes(needle),
    )
  }, [prospect, filter])

  function toggle(c: KeywordCandidate) {
    setSelected((prev) => {
      const next = new Set(prev)
      const k = c.keyword.toLowerCase()
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }

  const selectedCount = selected.size
  const L = run.locations.length
  const serpTasks = selectedCount * L
  const estCost = serpTasks * 0.0006 + L * 0.05

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-line bg-card px-5 py-4">
        <p className="text-[13.5px] font-medium text-foreground">
          Step 2 · Prune the curated list
        </p>
        <p className="mt-1 text-[13px] text-ink-2">
          {prospect.length} keywords survived clustering + geo + negative
          filtering. Uncheck anything you don&apos;t want, then run the paid
          city-volume + rank passes. Each market drops its own no-volume terms.
        </p>
      </div>

      {/* Cost estimate / action */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-card px-5 py-3">
        <div className="text-[13px] text-ink-2">
          <span className="font-semibold text-foreground tabular-nums">
            {selectedCount}
          </span>{" "}
          keywords × {L} {L === 1 ? "city" : "cities"} ≈{" "}
          <span className="tabular-nums">{serpTasks.toLocaleString()}</span> SERP
          checks · est.{" "}
          <span className="font-semibold text-foreground">
            ${estCost.toFixed(2)}
          </span>{" "}
          DataForSEO
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setSelected(new Set(prospect.map((c) => c.keyword.toLowerCase())))
            }
          >
            Select all
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSelected(new Set())}
          >
            Clear
          </Button>
          <Button
            disabled={busy || selectedCount === 0}
            onClick={() =>
              onSubmit(
                prospect
                  .filter((c) => selected.has(c.keyword.toLowerCase()))
                  .map((c) => c.keyword),
              )
            }
          >
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Run city volume + rank (paid)
          </Button>
        </div>
      </div>

      <div className="rounded-lg border border-line bg-card px-5 py-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            className="h-8 max-w-[280px]"
          />
          <span className="font-mono text-[11px] text-ink-3">
            {filtered.length} of {prospect.length}
          </span>
        </div>
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-line bg-muted/40 text-left">
                <th className="px-3 py-2" />
                <th className="px-3 py-2 font-medium text-ink-2">Seed</th>
                <th className="px-3 py-2 font-medium text-ink-2">Keyword</th>
                <th className="px-3 py-2 font-medium text-ink-2">Source</th>
                <th className="px-3 py-2 text-right font-medium text-ink-2">Nat vol</th>
                <th className="px-3 py-2 text-right font-medium text-ink-2">KD</th>
                <th className="px-3 py-2 font-medium text-ink-2">Intent</th>
                <th className="px-3 py-2 text-right font-medium text-ink-2">Var</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.keyword} className="border-b border-line/60">
                  <td className="px-3 py-1.5">
                    <input
                      type="checkbox"
                      checked={selected.has(c.keyword.toLowerCase())}
                      onChange={() => toggle(c)}
                      aria-label={`Select ${c.keyword}`}
                    />
                  </td>
                  <td className="px-3 py-1.5 text-ink-2">{c.seed}</td>
                  <td className="px-3 py-1.5 text-foreground">{c.keyword}</td>
                  <td className="px-3 py-1.5">
                    <span className="rounded-sm bg-secondary px-1.5 py-0.5 font-mono text-[10px] uppercase text-ink-2">
                      {c.source === "suggestions" ? "Sug" : "Rel"}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fmt(c.nationalVolume)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fmt(c.keywordDifficulty)}</td>
                  <td className="px-3 py-1.5 text-ink-2">{c.searchIntent ?? "—"}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{c.variantCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {drops.length > 0 ? (
        <div className="rounded-lg border border-line bg-card px-5 py-4">
          <button
            type="button"
            onClick={() => setShowDrops((s) => !s)}
            className="text-[12px] font-medium text-ink-2 hover:text-foreground"
          >
            {showDrops ? "− Hide" : "+ Show"} drop log ({drops.length}) — skim
            for false positives
          </button>
          {showDrops ? (
            <div className="mt-3 max-h-64 overflow-y-auto rounded border border-line/60">
              <table className="w-full border-collapse text-[11.5px]">
                <tbody>
                  {drops.map((d, i) => (
                    <tr key={`${d.keyword}-${i}`} className="border-b border-line/40">
                      <td className="px-3 py-1 text-foreground">{d.keyword}</td>
                      <td className="px-3 py-1 text-ink-3">{d.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// ── Results ──────────────────────────────────────────────────────────────────

function Results({ run }: { run: KeywordResearchRun }) {
  const result = run.result!
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-lg border border-[#0F6E56]/30 bg-[#0F6E56]/5 px-5 py-3">
        <CheckCircle2 className="h-5 w-5 text-[#0F6E56]" />
        <p className="text-[13.5px] text-foreground">
          Done. {result.locations.length}{" "}
          {result.locations.length === 1 ? "location" : "locations"} ·{" "}
          {result.durationSeconds}s · ${result.costUsd.toFixed(2)} DataForSEO.
        </p>
      </div>

      {result.warnings.length > 0 ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-[12.5px] text-amber-800">
          <div className="flex items-center gap-1.5 font-medium">
            <AlertTriangle className="h-3.5 w-3.5" /> Warnings
          </div>
          <ul className="mt-1 list-disc pl-5">
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {result.locations.map((loc) => (
        <div key={loc.slug} className="rounded-lg border border-line bg-card px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[14px] font-semibold text-foreground">{loc.label}</p>
              <p className="font-mono text-[11px] text-ink-3">
                {loc.rows.length} keywords with local volume · {loc.droppedNoVolume} dropped (no local volume)
                {loc.rankUnresolved > 0 ? ` · ${loc.rankUnresolved} rank unresolved` : ""}
              </p>
            </div>
            <a
              href={`/api/keywords/research/runs/${run.id}/csv?location=${encodeURIComponent(loc.slug)}`}
              download
            >
              <Button size="sm" variant="outline">
                <Download className="mr-1.5 h-3.5 w-3.5" /> Download CSV
              </Button>
            </a>
          </div>

          <div className="mt-3 overflow-x-auto rounded-lg border border-line">
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr className="border-b border-line bg-muted/40 text-left">
                  <th className="px-3 py-2 font-medium text-ink-2">Service</th>
                  <th className="px-3 py-2 font-medium text-ink-2">Keyword</th>
                  <th className="px-3 py-2 font-medium text-ink-2">Source</th>
                  <th className="px-3 py-2 text-right font-medium text-ink-2">City vol</th>
                  <th className="px-3 py-2 text-right font-medium text-ink-2">Rank</th>
                </tr>
              </thead>
              <tbody>
                {loc.rows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-ink-3">
                      No keywords had local search volume in this market.
                    </td>
                  </tr>
                ) : (
                  [...loc.rows]
                    .sort((a, b) => {
                      if (a.service !== b.service)
                        return a.service.localeCompare(b.service)
                      return (b.cityVolume ?? 0) - (a.cityVolume ?? 0)
                    })
                    .slice(0, 50)
                    .map((r) => (
                      <tr key={`${r.keyword}`} className="border-b border-line/60">
                        <td className="px-3 py-1.5 text-ink-2">{r.service}</td>
                        <td className="px-3 py-1.5 text-foreground">{r.keyword}</td>
                        <td className="px-3 py-1.5">
                          <span className="rounded-sm bg-secondary px-1.5 py-0.5 font-mono text-[10px] uppercase text-ink-2">
                            {r.source === "suggestions" ? "Sug" : "Rel"}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{fmt(r.cityVolume)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          {r.currentRank == null ? (
                            <span className="text-ink-3">not in top 20</span>
                          ) : (
                            r.currentRank
                          )}
                        </td>
                      </tr>
                    ))
                )}
              </tbody>
            </table>
          </div>
          {loc.rows.length > 50 ? (
            <p className="mt-2 font-mono text-[10.5px] text-ink-3">
              Showing top 50 of {loc.rows.length}. Download the CSV for the full list.
            </p>
          ) : null}
        </div>
      ))}
    </div>
  )
}
