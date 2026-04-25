"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Check,
  CheckCircle2,
  Copy,
  Download,
  Loader2,
  Plus,
  Trash2,
  XCircle,
} from "lucide-react"
import { toast } from "sonner"
import { PageHeader } from "@/components/PageHeader"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useSelectedPartner } from "@/lib/use-selected-partner"
import { findGscSiteCandidates } from "@/lib/gsc-site-match"
import { findGa4PropertyCandidates } from "@/lib/ga4-site-match"
import type {
  AuditSynthesis,
  GA4PropertyInfo,
  GSCSiteInfo,
  TargetMarket,
} from "@/lib/types"

/**
 * SEO Audit tab.
 *
 * Two run modes:
 *   1. PARTNER MODE — when a partner is selected via ?partnerId=, the page
 *      auto-resolves GSC + GA4 (same flow as Reporting), shows status
 *      badges, and posts { partnerId } to the orchestrator.
 *   2. PRE-SALES MODE — when no partner is selected, the page collapses to
 *      the prospect-form for raw domains we don't yet serve.
 *
 * The orchestration lives server-side in `/api/audit/pdf`; this page
 * surfaces the connection state and a simulated stage indicator while the
 * single long-running request is in flight.
 */

type Stage =
  | "idle"
  | "crawling"
  | "fetching-gsc-ga4"
  | "competitive"
  | "backlinks"
  | "synthesizing"
  | "rendering"
  | "done"
  | "error"

const STAGE_LABELS: Record<
  Exclude<Stage, "idle" | "done" | "error">,
  string
> = {
  crawling: "Crawling site",
  "fetching-gsc-ga4": "Pulling GSC + GA4",
  competitive: "Competitive analysis",
  backlinks: "Backlink snapshot",
  synthesizing: "Generating findings",
  rendering: "Rendering PDF",
}

const STAGE_DURATIONS_SEC: Record<keyof typeof STAGE_LABELS, number> = {
  crawling: 45,
  "fetching-gsc-ga4": 30,
  competitive: 60,
  backlinks: 15,
  synthesizing: 90,
  rendering: 10,
}

interface AuditResult {
  url: string
  synthesis: AuditSynthesis
  durationSeconds: number
  costUsd: number
  costBreakdown: {
    dataforseoUsd: number
    claudeUsd: number
    dataforseoCalls: number
    claudeInputTokens: number
    claudeOutputTokens: number
  }
}

type GscState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready"
      candidates: GSCSiteInfo[]
      hasMatch: boolean
    }

type Ga4State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready"
      candidates: GA4PropertyInfo[]
      source: "airtable" | "auto" | "none"
    }

interface PreSalesFormState {
  domain: string
  markets: TargetMarket[]
  competitors: string[]
  seedServices: string
  contactName: string
}

function blankMarket(): TargetMarket {
  return { city: "", state: "" }
}

function initialPreSales(): PreSalesFormState {
  return {
    domain: "",
    markets: [blankMarket()],
    competitors: [""],
    seedServices: "",
    contactName: "",
  }
}

function cleanDomain(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase()
}

function validatePreSales(form: PreSalesFormState): string | null {
  if (!cleanDomain(form.domain)) return "Prospect domain is required."
  const valid = form.markets.filter((m) => m.city.trim() && m.state.trim())
  if (valid.length === 0)
    return "Add at least one target market (city + state)."
  return null
}

export default function AuditPage() {
  const { partner, loading: partnerLoading, error: partnerError } =
    useSelectedPartner()
  const [preSales, setPreSales] = useState<PreSalesFormState>(initialPreSales)
  const [stage, setStage] = useState<Stage>("idle")
  const [elapsedSec, setElapsedSec] = useState(0)
  const [result, setResult] = useState<AuditResult | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [gscState, setGscState] = useState<GscState>({ status: "idle" })
  const [ga4State, setGa4State] = useState<Ga4State>({ status: "idle" })

  const running = stage !== "idle" && stage !== "done" && stage !== "error"

  // Auto-resolve GSC site list when a partner is selected — mirrors
  // Reporting tab's flow.
  useEffect(() => {
    if (!partner) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setGscState({ status: "idle" })
      return
    }
    const partnerWebsite = partner.website
    const abort = new AbortController()
    setGscState({ status: "loading" })
    async function load() {
      try {
        const r = await fetch("/api/gsc/sites", { signal: abort.signal })
        const body = (await r.json().catch(() => ({}))) as {
          sites?: GSCSiteInfo[]
          error?: string
        }
        if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`)
        const candidates = findGscSiteCandidates(
          partnerWebsite,
          body.sites ?? [],
        )
        setGscState({
          status: "ready",
          candidates,
          hasMatch: candidates.length > 0,
        })
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") return
        setGscState({
          status: "error",
          message: err instanceof Error ? err.message : "Failed to load GSC sites",
        })
      }
    }
    load()
    return () => abort.abort()
  }, [partner])

  // Auto-resolve GA4 — mirrors Reporting tab's logic exactly.
  useEffect(() => {
    if (!partner) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setGa4State({ status: "idle" })
      return
    }
    const partnerWebsite = partner.website
    const airtableOverride = partner.ga4PropertyId
    const abort = new AbortController()
    setGa4State({ status: "loading" })
    async function load() {
      try {
        const r = await fetch("/api/ga4/properties", { signal: abort.signal })
        const body = (await r.json().catch(() => ({}))) as {
          properties?: GA4PropertyInfo[]
          error?: string
        }
        if (!r.ok) {
          if (airtableOverride) {
            setGa4State({
              status: "ready",
              source: "airtable",
              candidates: [
                {
                  propertyId: airtableOverride.startsWith("properties/")
                    ? airtableOverride
                    : `properties/${airtableOverride}`,
                  displayName: "(from Airtable)",
                },
              ],
            })
            return
          }
          throw new Error(body.error ?? `HTTP ${r.status}`)
        }
        const all = body.properties ?? []
        if (airtableOverride) {
          const norm = airtableOverride.startsWith("properties/")
            ? airtableOverride
            : `properties/${airtableOverride}`
          const found = all.find((p) => p.propertyId === norm)
          setGa4State({
            status: "ready",
            source: "airtable",
            candidates: found
              ? [found]
              : [{ propertyId: norm, displayName: "(from Airtable)" }],
          })
          return
        }
        const matched = findGa4PropertyCandidates(partnerWebsite, all)
        setGa4State({
          status: "ready",
          source: matched.length > 0 ? "auto" : "none",
          candidates: matched,
        })
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") return
        setGa4State({
          status: "error",
          message:
            err instanceof Error ? err.message : "Failed to load GA4 properties",
        })
      }
    }
    load()
    return () => abort.abort()
  }, [partner])

  const startStageTimer = useCallback(() => {
    const stages = Object.keys(STAGE_LABELS) as (keyof typeof STAGE_LABELS)[]
    let idx = 0
    setStage(stages[0])
    setElapsedSec(0)
    const startedAt = Date.now()
    const tick = setInterval(() => {
      const el = Math.floor((Date.now() - startedAt) / 1000)
      setElapsedSec(el)
      let running = 0
      for (let i = 0; i < stages.length; i++) {
        running += STAGE_DURATIONS_SEC[stages[i]]
        if (el < running) {
          if (idx !== i) {
            idx = i
            setStage(stages[i])
          }
          return
        }
      }
      idx = stages.length - 1
      setStage(stages[stages.length - 1])
    }, 500)
    return () => clearInterval(tick)
  }, [])

  const runPartnerAudit = useCallback(async () => {
    if (!partner) return
    setErrorMessage(null)
    setResult(null)
    setCopied(false)
    const stopTimer = startStageTimer()
    try {
      const res = await fetch("/api/audit/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partnerId: partner.id }),
      })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(text || `HTTP ${res.status}`)
      }
      const data = (await res.json()) as AuditResult
      stopTimer()
      setStage("done")
      setResult(data)
    } catch (err) {
      stopTimer()
      setStage("error")
      const message = err instanceof Error ? err.message : "Unknown error"
      setErrorMessage(message)
      toast.error("Audit failed", { description: message })
    }
  }, [partner, startStageTimer])

  const runPreSalesAudit = useCallback(async () => {
    const problem = validatePreSales(preSales)
    if (problem) {
      setErrorMessage(problem)
      return
    }
    setErrorMessage(null)
    setResult(null)
    setCopied(false)
    const stopTimer = startStageTimer()
    const payload = {
      prospect: {
        domain: cleanDomain(preSales.domain),
        targetMarkets: preSales.markets.filter(
          (m) => m.city.trim() && m.state.trim(),
        ),
        competitors: preSales.competitors
          .map((c) => cleanDomain(c))
          .filter((c) => c.length > 0),
        contactName: preSales.contactName.trim() || undefined,
      },
      seedServices: preSales.seedServices
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .slice(0, 5),
    }
    try {
      const res = await fetch("/api/audit/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(text || `HTTP ${res.status}`)
      }
      const data = (await res.json()) as AuditResult
      stopTimer()
      setStage("done")
      setResult(data)
    } catch (err) {
      stopTimer()
      setStage("error")
      const message = err instanceof Error ? err.message : "Unknown error"
      setErrorMessage(message)
      toast.error("Audit failed", { description: message })
    }
  }, [preSales, startStageTimer])

  const copyLink = useCallback(async () => {
    if (!result) return
    try {
      await navigator.clipboard.writeText(result.url)
      setCopied(true)
      toast.success("Link copied to clipboard")
      setTimeout(() => setCopied(false), 3000)
    } catch {
      toast.error("Clipboard unavailable — copy the URL manually.")
    }
  }, [result])

  const partnerMode = Boolean(partner)
  const gscConnected =
    gscState.status === "ready" ? gscState.hasMatch : false
  const monthsAvailable = useMemo(
    () => (gscConnected ? "16mo available" : null),
    [gscConnected],
  )

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Workflow / SEO Audit"
        title="SEO Audit"
        tail="— full-funnel deliverable"
        subtitle={
          <>
            Run a full audit against the selected partner&apos;s{" "}
            <b className="font-sans font-extrabold not-italic text-foreground">
              GSC
            </b>{" "}
            and{" "}
            <b className="font-sans font-extrabold not-italic text-foreground">
              GA4
            </b>{" "}
            data. If neither is connected the audit falls back to{" "}
            <b className="font-sans font-extrabold not-italic text-foreground">
              third-party estimates
            </b>{" "}
            and is clearly flagged as a limited audit.
          </>
        }
      />

      {partnerLoading ? (
        <p className="text-sm text-muted-foreground">Loading partner…</p>
      ) : partnerError ? (
        <p className="text-sm text-destructive" role="alert">
          {partnerError}
        </p>
      ) : partnerMode ? (
        <PartnerRunPanel
          partnerName={partner!.name}
          gscState={gscState}
          ga4State={ga4State}
          monthsAvailable={monthsAvailable}
          disabled={running}
          onRun={runPartnerAudit}
        />
      ) : (
        <PreSalesForm
          form={preSales}
          setForm={setPreSales}
          disabled={running}
          onRun={runPreSalesAudit}
        />
      )}

      {errorMessage && !running && (
        <div
          role="alert"
          className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {errorMessage}
        </div>
      )}

      {running && <ProgressIndicator stage={stage} elapsedSec={elapsedSec} />}

      {stage === "done" && result && (
        <AuditResultPanel
          result={result}
          copied={copied}
          onCopy={copyLink}
        />
      )}
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Partner-mode launch panel: status badges + Run button.

function PartnerRunPanel({
  partnerName,
  gscState,
  ga4State,
  monthsAvailable,
  disabled,
  onRun,
}: {
  partnerName: string
  gscState: GscState
  ga4State: Ga4State
  monthsAvailable: string | null
  disabled: boolean
  onRun: () => void
}) {
  const limited =
    gscState.status === "ready" &&
    !gscState.hasMatch &&
    (ga4State.status === "ready" && ga4State.source === "none")

  return (
    <section className="space-y-4 rounded-lg border bg-card p-5">
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">
          Audit subject
        </span>
        <span className="text-base font-semibold">{partnerName}</span>
      </div>

      <div className="flex flex-wrap gap-2">
        <ConnectionBadge
          label="GSC"
          state={
            gscState.status === "loading"
              ? "loading"
              : gscState.status === "ready"
                ? gscState.hasMatch
                  ? "connected"
                  : "missing"
                : "error"
          }
          detail={
            gscState.status === "ready" && gscState.hasMatch && monthsAvailable
              ? `connected (${monthsAvailable})`
              : gscState.status === "ready" && !gscState.hasMatch
                ? "not connected — falling back to third-party estimates"
                : gscState.status === "error"
                  ? gscState.message
                  : undefined
          }
        />
        <ConnectionBadge
          label="GA4"
          state={
            ga4State.status === "loading"
              ? "loading"
              : ga4State.status === "ready"
                ? ga4State.source === "none"
                  ? "missing"
                  : "connected"
                : "error"
          }
          detail={
            ga4State.status === "ready" && ga4State.source !== "none"
              ? `connected (${ga4State.source === "airtable" ? "Airtable override" : "auto-detected"})`
              : ga4State.status === "ready" && ga4State.source === "none"
                ? "not connected — traffic findings will be third-party estimates"
                : ga4State.status === "error"
                  ? ga4State.message
                  : undefined
          }
        />
      </div>

      {limited && (
        <p className="rounded-md border border-amber-400/50 bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-900/20 dark:text-amber-200">
          <strong>Limited audit:</strong> neither GSC nor GA4 are connected. The
          report will run on crawl + DataForSEO and clearly flag the data gap.
          Verify the SEO Ops Google account has access to this partner&apos;s
          properties before re-running.
        </p>
      )}

      <div className="flex justify-end border-t pt-4">
        <Button type="button" onClick={onRun} disabled={disabled}>
          {disabled ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Running audit…
            </>
          ) : (
            "Run audit"
          )}
        </Button>
      </div>
    </section>
  )
}

function ConnectionBadge({
  label,
  state,
  detail,
}: {
  label: string
  state: "loading" | "connected" | "missing" | "error"
  detail?: string
}) {
  if (state === "loading") {
    return (
      <Badge variant="outline" className="gap-1">
        <Loader2 className="h-3 w-3 animate-spin" />
        {label}: resolving…
      </Badge>
    )
  }
  if (state === "connected") {
    return (
      <Badge variant="outline" className="gap-1 border-emerald-500/40 text-emerald-700 dark:text-emerald-300">
        <CheckCircle2 className="h-3 w-3" />
        {label}: ✓ {detail ?? "connected"}
      </Badge>
    )
  }
  if (state === "missing") {
    return (
      <Badge variant="outline" className="gap-1 border-amber-500/40 text-amber-700 dark:text-amber-300" title={detail}>
        <XCircle className="h-3 w-3" />
        {label}: {detail ?? "not connected"}
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="gap-1 border-destructive/40 text-destructive" title={detail}>
      <XCircle className="h-3 w-3" />
      {label}: error
    </Badge>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Pre-sales form for raw prospects (no Airtable record).

function PreSalesForm({
  form,
  setForm,
  disabled,
  onRun,
}: {
  form: PreSalesFormState
  setForm: (updater: (prev: PreSalesFormState) => PreSalesFormState) => void
  disabled: boolean
  onRun: () => void
}) {
  return (
    <section className="space-y-5 rounded-lg border bg-card p-5">
      <p className="rounded-md border border-amber-400/50 bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-900/20 dark:text-amber-200">
        No partner selected. Use this form for pre-sales audits against
        prospects we don&apos;t yet serve. The audit will run on crawl +
        DataForSEO + third-party estimates and be flagged accordingly.
        For partner audits, select a partner from the dropdown above.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="domain">Prospect domain</Label>
          <Input
            id="domain"
            placeholder="examplelandscaping.com"
            value={form.domain}
            onChange={(e) =>
              setForm((p) => ({ ...p, domain: e.target.value }))
            }
            disabled={disabled}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="contactName">Contact name (optional)</Label>
          <Input
            id="contactName"
            placeholder="Jane Smith"
            value={form.contactName}
            onChange={(e) =>
              setForm((p) => ({ ...p, contactName: e.target.value }))
            }
            disabled={disabled}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label>Target markets</Label>
        <div className="space-y-2">
          {form.markets.map((m, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
              <Input
                placeholder="City (e.g. Atlanta)"
                value={m.city}
                onChange={(e) =>
                  setForm((p) => {
                    const next = [...p.markets]
                    next[i] = { ...next[i], city: e.target.value }
                    return { ...p, markets: next }
                  })
                }
                disabled={disabled}
              />
              <Input
                placeholder="State (e.g. Georgia)"
                value={m.state}
                onChange={(e) =>
                  setForm((p) => {
                    const next = [...p.markets]
                    next[i] = { ...next[i], state: e.target.value }
                    return { ...p, markets: next }
                  })
                }
                disabled={disabled}
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                disabled={disabled || form.markets.length === 1}
                onClick={() =>
                  setForm((p) => ({
                    ...p,
                    markets: p.markets.filter((_, idx) => idx !== i),
                  }))
                }
                aria-label="Remove market"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || form.markets.length >= 5}
          onClick={() =>
            setForm((p) => ({ ...p, markets: [...p.markets, blankMarket()] }))
          }
        >
          <Plus className="mr-1 h-4 w-4" /> Add market
        </Button>
      </div>

      <div className="space-y-2">
        <Label>
          Competitor domains (optional — leave blank to auto-suggest)
        </Label>
        <div className="space-y-2">
          {form.competitors.map((c, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[1fr_auto]">
              <Input
                placeholder="competitor.com"
                value={c}
                onChange={(e) =>
                  setForm((p) => {
                    const next = [...p.competitors]
                    next[i] = e.target.value
                    return { ...p, competitors: next }
                  })
                }
                disabled={disabled}
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                disabled={disabled || form.competitors.length === 1}
                onClick={() =>
                  setForm((p) => ({
                    ...p,
                    competitors: p.competitors.filter((_, idx) => idx !== i),
                  }))
                }
                aria-label="Remove competitor"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || form.competitors.length >= 5}
          onClick={() =>
            setForm((p) => ({ ...p, competitors: [...p.competitors, ""] }))
          }
        >
          <Plus className="mr-1 h-4 w-4" /> Add competitor
        </Button>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="seedServices">
          Seed services (used only for auto-suggesting competitors)
        </Label>
        <Textarea
          id="seedServices"
          placeholder="plumber, drain cleaning, water heater repair"
          value={form.seedServices}
          onChange={(e) =>
            setForm((p) => ({ ...p, seedServices: e.target.value }))
          }
          disabled={disabled}
          rows={2}
        />
      </div>

      <div className="flex items-center justify-end gap-2 border-t pt-4">
        <Button type="button" onClick={onRun} disabled={disabled}>
          {disabled ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Running audit…
            </>
          ) : (
            "Run audit"
          )}
        </Button>
      </div>
    </section>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Progress indicator (simulated stage timer).

function ProgressIndicator({
  stage,
  elapsedSec,
}: {
  stage: Stage
  elapsedSec: number
}) {
  const stages = Object.keys(STAGE_LABELS) as (keyof typeof STAGE_LABELS)[]
  const activeIdx = stages.indexOf(stage as keyof typeof STAGE_LABELS)
  return (
    <section className="rounded-lg border bg-card p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Running audit</h2>
        <span className="font-mono text-xs text-muted-foreground">
          {Math.floor(elapsedSec / 60)}:
          {String(elapsedSec % 60).padStart(2, "0")}
        </span>
      </div>
      <ol className="mt-4 space-y-2">
        {stages.map((s, i) => {
          const label = STAGE_LABELS[s]
          const done = i < activeIdx
          const active = i === activeIdx
          return (
            <li key={s} className="flex items-center gap-3 text-sm">
              <span
                className="flex h-5 w-5 items-center justify-center rounded-full border"
                aria-hidden
              >
                {done ? (
                  <Check className="h-3 w-3" />
                ) : active ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : null}
              </span>
              <span
                className={
                  done
                    ? "text-muted-foreground line-through"
                    : active
                      ? "font-medium"
                      : "text-muted-foreground"
                }
              >
                {label}
              </span>
            </li>
          )
        })}
      </ol>
      <p className="mt-4 text-xs text-muted-foreground">
        Typical audits take 4–8 minutes. Keep this tab open.
      </p>
    </section>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Result panel.

function AuditResultPanel({
  result,
  copied,
  onCopy,
}: {
  result: AuditResult
  copied: boolean
  onCopy: () => void
}) {
  const { url, synthesis, durationSeconds, costUsd, costBreakdown } = result
  const minutes = Math.max(1, Math.round(durationSeconds / 60))
  const fullData =
    synthesis.dataSources.gscIncluded || synthesis.dataSources.ga4Included
  return (
    <section className="space-y-4">
      <div className="rounded-lg border bg-card p-5">
        <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
          <div>
            <h2 className="text-lg font-semibold">Audit ready</h2>
            <p className="text-sm text-muted-foreground">
              {synthesis.prospectDomain} · generated in {minutes} minute
              {minutes === 1 ? "" : "s"} ·{" "}
              {fullData
                ? "first-party data"
                : "limited audit (third-party estimates)"}
            </p>
          </div>
          <div className="flex gap-2">
            <Button asChild variant="default">
              <a href={url} download target="_blank" rel="noopener noreferrer">
                <Download className="mr-2 h-4 w-4" /> Download PDF
              </a>
            </Button>
            <Button type="button" variant="outline" onClick={onCopy}>
              {copied ? (
                <>
                  <Check className="mr-2 h-4 w-4" /> Copied
                </>
              ) : (
                <>
                  <Copy className="mr-2 h-4 w-4" /> Copy link
                </>
              )}
            </Button>
          </div>
        </div>

        <div className="mt-4 rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
          <div>
            DataForSEO: ${costBreakdown.dataforseoUsd.toFixed(3)} (
            {costBreakdown.dataforseoCalls} calls)
          </div>
          <div>
            Claude: ${costBreakdown.claudeUsd.toFixed(3)} (
            {costBreakdown.claudeInputTokens.toLocaleString()} in /{" "}
            {costBreakdown.claudeOutputTokens.toLocaleString()} out)
          </div>
          <div className="mt-1 font-medium text-foreground">
            Total: ${costUsd.toFixed(3)}
          </div>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-2">
        <object
          data={url}
          type="application/pdf"
          className="block h-[900px] w-full"
          aria-label="Audit PDF preview"
        >
          <p className="p-6 text-sm text-muted-foreground">
            PDF preview not available in this browser.{" "}
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              Open the PDF in a new tab.
            </a>
          </p>
        </object>
      </div>
    </section>
  )
}
