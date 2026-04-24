"use client"

import { useCallback, useState } from "react"
import { Check, Copy, Download, Loader2, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type { AuditSynthesis, TargetMarket } from "@/lib/types"

/**
 * SEO Audit tab.
 *
 * Form → "Run Audit" → multi-stage progress → PDF preview + download + copy
 * shareable link. The orchestration lives server-side in
 * `/api/audit/pdf`; this page just posts the form, shows progress while
 * the request is in flight, and renders the result.
 *
 * Because the whole pipeline takes 3-8 minutes and arrives as a single
 * response, the "progress" indicator here is a simulated stage counter
 * rather than real streaming — it advances on a timer roughly matching
 * typical stage durations so the MD sees something during the wait.
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

const STAGE_LABELS: Record<Exclude<Stage, "idle" | "done" | "error">, string> = {
  crawling: "Crawling site",
  "fetching-gsc-ga4": "Pulling GSC + GA4",
  competitive: "Competitive analysis",
  backlinks: "Backlink snapshot",
  synthesizing: "Generating findings",
  rendering: "Rendering PDF",
}

// Rough durations in seconds — sum should be ≈ 4 minutes to match real wall
// clock on a normal audit. Timing isn't exact; this just gives the MD something
// to watch. Real stages run in parallel server-side.
const STAGE_DURATIONS_SEC: Record<keyof typeof STAGE_LABELS, number> = {
  crawling: 45,
  "fetching-gsc-ga4": 20,
  competitive: 60,
  backlinks: 15,
  synthesizing: 60,
  rendering: 10,
}

interface FormState {
  domain: string
  markets: TargetMarket[]
  competitors: string[]
  seedServices: string
  gscSiteUrl: string
  ga4PropertyId: string
  contactName: string
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

function blankMarket(): TargetMarket {
  return { city: "", state: "" }
}

function initialState(): FormState {
  return {
    domain: "",
    markets: [blankMarket()],
    competitors: [""],
    seedServices: "",
    gscSiteUrl: "",
    ga4PropertyId: "",
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

function validate(form: FormState): string | null {
  if (!cleanDomain(form.domain)) return "Prospect domain is required."
  const validMarkets = form.markets.filter(
    (m) => m.city.trim() && m.state.trim(),
  )
  if (validMarkets.length === 0)
    return "Add at least one target market (city + state)."
  return null
}

export default function AuditPage() {
  const [form, setForm] = useState<FormState>(initialState)
  const [stage, setStage] = useState<Stage>("idle")
  const [elapsedSec, setElapsedSec] = useState(0)
  const [result, setResult] = useState<AuditResult | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const running = stage !== "idle" && stage !== "done" && stage !== "error"

  const startStageTimer = useCallback(() => {
    // Advance the stage indicator on a schedule. Server runs stages in
    // parallel, so this is a UI progress bar not a true state machine.
    const stages: (keyof typeof STAGE_LABELS)[] = [
      "crawling",
      "fetching-gsc-ga4",
      "competitive",
      "backlinks",
      "synthesizing",
      "rendering",
    ]
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
      // All stages elapsed; hold on last stage until the fetch settles.
      idx = stages.length - 1
      setStage(stages[stages.length - 1])
    }, 500)
    return () => clearInterval(tick)
  }, [])

  const runAudit = useCallback(async () => {
    const problem = validate(form)
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
        domain: cleanDomain(form.domain),
        targetMarkets: form.markets.filter(
          (m) => m.city.trim() && m.state.trim(),
        ),
        competitors: form.competitors
          .map((c) => cleanDomain(c))
          .filter((c) => c.length > 0),
        gscSiteUrl: form.gscSiteUrl.trim() || undefined,
        ga4PropertyId: form.ga4PropertyId.trim() || undefined,
        contactName: form.contactName.trim() || undefined,
      },
      seedServices: form.seedServices
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
  }, [form, startStageTimer])

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

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">SEO Audit</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Generate a pre-sales audit PDF for a prospective partner. GSC and GA4
          are optional — when absent, the audit runs on crawl + DataForSEO data
          and is marked as a limited audit.
        </p>
      </header>

      <AuditForm
        form={form}
        setForm={setForm}
        disabled={running}
        onRun={runAudit}
      />

      {errorMessage && !running && (
        <div
          role="alert"
          className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {errorMessage}
        </div>
      )}

      {running && (
        <ProgressIndicator stage={stage} elapsedSec={elapsedSec} />
      )}

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
// Form.

function AuditForm({
  form,
  setForm,
  disabled,
  onRun,
}: {
  form: FormState
  setForm: (updater: (prev: FormState) => FormState) => void
  disabled: boolean
  onRun: () => void
}) {
  const limitedAudit = !form.gscSiteUrl.trim() && !form.ga4PropertyId.trim()

  return (
    <section className="space-y-5 rounded-lg border bg-card p-5">
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
        <Label>Competitor domains (optional — leave blank to auto-suggest)</Label>
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

      <details className="rounded-md border bg-muted/20 p-3">
        <summary className="cursor-pointer text-sm font-medium">
          Optional: GSC / GA4 access (run a full audit)
        </summary>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="gscSiteUrl">GSC site URL</Label>
            <Input
              id="gscSiteUrl"
              placeholder="https://examplelandscaping.com/"
              value={form.gscSiteUrl}
              onChange={(e) =>
                setForm((p) => ({ ...p, gscSiteUrl: e.target.value }))
              }
              disabled={disabled}
            />
            <p className="text-xs text-muted-foreground">
              URL-prefix property or sc-domain:example.com.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ga4PropertyId">GA4 property ID</Label>
            <Input
              id="ga4PropertyId"
              placeholder="123456789"
              value={form.ga4PropertyId}
              onChange={(e) =>
                setForm((p) => ({ ...p, ga4PropertyId: e.target.value }))
              }
              disabled={disabled}
            />
            <p className="text-xs text-muted-foreground">
              Numeric ID or properties/123456789.
            </p>
          </div>
        </div>
        {limitedAudit && (
          <p className="mt-3 rounded-md border border-amber-400/50 bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-900/20 dark:text-amber-200">
            <strong>Limited audit:</strong> without GSC/GA4 the audit runs on
            crawl + DataForSEO data only. The PDF will be marked accordingly.
          </p>
        )}
      </details>

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
        Typical audits take 3–8 minutes. Keep this tab open.
      </p>
    </section>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Result panel — PDF embed, download, shareable link, cost breakdown.

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
  return (
    <section className="space-y-4">
      <div className="rounded-lg border bg-card p-5">
        <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
          <div>
            <h2 className="text-lg font-semibold">Audit ready</h2>
            <p className="text-sm text-muted-foreground">
              {synthesis.prospectDomain} · generated in {minutes} minute
              {minutes === 1 ? "" : "s"}
              {synthesis.dataSources.gscIncluded ||
              synthesis.dataSources.ga4Included
                ? " · full-data audit"
                : " · limited audit (no GSC/GA4)"}
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
