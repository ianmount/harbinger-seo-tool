"use client"

import { useCallback, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import ReactMarkdown from "react-markdown"
import rehypeRaw from "rehype-raw"
import { Download, ExternalLink, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { PageHeader } from "@/components/PageHeader"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useAssessment } from "@/lib/assessment-context"
import { useChatPageContext } from "@/lib/chat-context"
import { parseTargetLocationLines } from "@/lib/locations"
import { generateAuditId, saveAudit } from "@/lib/audit-storage"
import type { AssessmentAuditResult, AuditDataBundle } from "@/lib/types"

/**
 * Assessment Audit tab.
 *
 * Stateless manual-input flow. The form fields are persisted in the
 * shared Assessment context so the Comp Analysis tab can pre-fill from
 * them. Refreshing the page wipes everything — that's intended.
 */

type Stage =
  | "idle"
  | "gathering"
  | "synthesizing"
  | "done"
  | "error"

const STAGE_LABEL: Record<Exclude<Stage, "idle" | "done" | "error">, string> = {
  gathering: "Gathering audit data",
  synthesizing: "Synthesizing audit",
}

const URL_REGEX = /^(https?:\/\/)?[\w-]+(\.[\w-]+)+([/?#].*)?$/i

/**
 * NDJSON stream reader for /api/audit/run. Yields the bundle from the
 * terminal `result` event. Throws on the terminal `error` event or if
 * the stream closes without a result. Ignores `ping` events and
 * surfaces stage / warning events via `onStage`.
 */
async function readGatherStream(
  body: ReadableStream<Uint8Array>,
  onStage: (label: string | null) => void,
): Promise<AuditDataBundle> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let bundle: AuditDataBundle | null = null
  let streamError: string | null = null

  const labelFor = (stage: string, detail?: string): string => {
    const friendly: Record<string, string> = {
      starting: "Starting audit",
      gsc_ready: "Search Console data ready",
      crawl_progress: "Crawling site",
      crawl_done: "Crawl complete",
      pagespeed_done: "PageSpeed complete",
      parallel_done: "Gather phase complete",
      index_coverage_started: "Checking indexation coverage",
      index_coverage_done: "Indexation coverage complete",
    }
    const base = friendly[stage] ?? stage.replace(/_/g, " ")
    return detail ? `${base} — ${detail}` : base
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let event: { type: string; [k: string]: unknown }
      try {
        event = JSON.parse(trimmed) as { type: string; [k: string]: unknown }
      } catch {
        continue
      }
      if (event.type === "ping") continue
      if (event.type === "stage") {
        onStage(
          labelFor(
            String(event.stage ?? ""),
            typeof event.detail === "string" ? event.detail : undefined,
          ),
        )
      } else if (event.type === "result") {
        bundle = event.bundle as AuditDataBundle
      } else if (event.type === "error") {
        streamError =
          typeof event.error === "string" ? event.error : "Stream error"
      }
    }
  }
  if (streamError) throw new Error(streamError)
  if (!bundle) {
    throw new Error("Gather stream closed without a result event")
  }
  return bundle
}

export default function AuditPage() {
  const router = useRouter()
  const { state, setField, setMany } = useAssessment()
  const [stage, setStage] = useState<Stage>("idle")
  const [stageDetail, setStageDetail] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [lastAuditId, setLastAuditId] = useState<string | null>(null)

  const running =
    stage !== "idle" && stage !== "done" && stage !== "error"

  const auditResult = state.auditResult
  const targetLocationsParsed = useMemo(
    () => parseTargetLocationLines(state.targetLocations),
    [state.targetLocations],
  )

  // Audit form/result state already flows into the chat via the
  // AssessmentContext auto-pull in AppShell. This hook adds the
  // page-local UI stage so the chat can answer "why is this taking so
  // long" mid-run.
  useChatPageContext("audit", {
    tab: "Audit",
    summary: [
      `Run stage: ${stage}${stageDetail ? ` (${stageDetail})` : ""}.`,
      validationError ? `Validation issue: ${validationError}.` : "",
      errorMessage ? `Last error: ${errorMessage}.` : "",
      targetLocationsParsed.length > 0
        ? `${targetLocationsParsed.length} target location(s) parsed.`
        : "",
    ]
      .filter(Boolean)
      .join(" "),
    data: {
      stage,
      stageDetail,
      hasValidationError: !!validationError,
      lastErrorMessage: errorMessage,
      parsedLocationCount: targetLocationsParsed.length,
    },
  })

  const validate = useCallback((): string | null => {
    if (!state.websiteUrl.trim()) return "Website URL is required."
    if (!URL_REGEX.test(state.websiteUrl.trim())) {
      return "Website URL doesn't look valid (e.g. https://example.com)."
    }
    return null
  }, [state.websiteUrl])

  const runAudit = useCallback(async () => {
    const problem = validate()
    if (problem) {
      setValidationError(problem)
      return
    }
    setValidationError(null)
    setErrorMessage(null)

    // Step 1: gather data. /api/audit/run streams NDJSON — pings every
    // 10s keep the connection alive across the multi-minute crawl, stage
    // events drive the progress label, and the terminal `result` event
    // carries the bundle. Without streaming, idle-connection timeouts in
    // browsers and intermediate proxies surface as "Failed to fetch" on
    // the client even when the function is still running cleanly.
    setStage("gathering")
    setStageDetail(null)
    let bundle: AuditDataBundle
    try {
      const res = await fetch("/api/audit/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          websiteUrl: state.websiteUrl.trim(),
          priorityServices: state.priorityServices,
          negativeKeywords: state.negativeKeywords,
          existingTargetKeywords: state.existingTargetKeywords,
          idealCustomer: state.idealCustomer,
          targetMarkets: targetLocationsParsed,
        }),
      })
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "")
        throw new Error(text.slice(0, 300) || `HTTP ${res.status}`)
      }
      bundle = await readGatherStream(res.body, setStageDetail)
    } catch (err) {
      setStage("error")
      setStageDetail(null)
      const message = err instanceof Error ? err.message : "Unknown error"
      setErrorMessage(`Data gather failed: ${message}`)
      toast.error("Audit failed", { description: message })
      return
    }

    // Step 2: synthesize. /api/audit/synthesize takes the bundle, returns
    // the markdown. Each request gets its own 800s Vercel function budget.
    setStage("synthesizing")
    setStageDetail(null)
    let auditMarkdown: string
    let synthesisDurationSeconds = 0
    try {
      const res = await fetch("/api/audit/synthesize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bundle),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const json = (await res.json()) as {
        auditMarkdown: string
        synthesisDurationSeconds: number
      }
      auditMarkdown = json.auditMarkdown
      synthesisDurationSeconds = json.synthesisDurationSeconds
    } catch (err) {
      setStage("error")
      const message = err instanceof Error ? err.message : "Unknown error"
      setErrorMessage(
        `Audit data was gathered but Claude synthesis failed: ${message}. Re-run to retry.`,
      )
      toast.error("Synthesis failed", { description: message })
      return
    }

    const result: AssessmentAuditResult = {
      websiteUrl: bundle.websiteUrl,
      generatedAt: bundle.generatedAt,
      auditMarkdown,
      warnings: bundle.warnings,
      gscData: bundle.gsc,
      ga4Data: bundle.ga4,
      crawlSummary: bundle.crawlSummary,
      cannibalization: bundle.cannibalization,
      durationSeconds: bundle.gatherDurationSeconds + synthesisDurationSeconds,
    }
    setField("auditResult", result)
    const id = generateAuditId()
    saveAudit({
      id,
      result,
      compAnalysisRows: state.compAnalysisRows,
      storedAt: new Date().toISOString(),
    })
    setLastAuditId(id)
    setStage("done")
    if (result.warnings.length > 0) {
      toast.warning("Audit completed with warnings", {
        description: result.warnings[0],
      })
    } else {
      toast.success("Audit ready")
    }
    router.push(`/audits/${id}`)
  }, [
    validate,
    state.websiteUrl,
    state.priorityServices,
    state.negativeKeywords,
    state.existingTargetKeywords,
    state.idealCustomer,
    state.compAnalysisRows,
    targetLocationsParsed,
    setField,
    router,
  ])

  const downloadMarkdown = useCallback(() => {
    if (!auditResult) return
    const filename = `audit-${auditResult.websiteUrl.replace(/[^a-zA-Z0-9.-]/g, "_")}-${auditResult.generatedAt.slice(0, 10)}.md`
    const blob = new Blob([auditResult.auditMarkdown], {
      type: "text/markdown",
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, [auditResult])

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Assessments / Audit"
        title="SEO Audit"
        tail="— prospect evaluation"
        subtitle={
          <>
            Stateless audit for a prospective partner. Enter the prospect&apos;s
            business context and target locations; the audit pulls{" "}
            <b className="font-sans font-extrabold not-italic text-foreground">
              GSC
            </b>{" "}
            and{" "}
            <b className="font-sans font-extrabold not-italic text-foreground">
              GA4
            </b>{" "}
            data through the assessments Google account, crawls the site, and
            synthesizes findings biased by the priorities you provide.
          </>
        }
      />

      <section className="space-y-5 rounded-lg border bg-card p-5">
        <div className="space-y-1.5">
          <Label htmlFor="websiteUrl">Website URL</Label>
          <Input
            id="websiteUrl"
            placeholder="https://examplelandscaping.com"
            value={state.websiteUrl}
            onChange={(e) => {
              setMany({ websiteUrl: e.target.value, auditResult: null })
            }}
            disabled={running}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="priorityServices">Priority services</Label>
          <Textarea
            id="priorityServices"
            placeholder="e.g. kitchen remodeling, bathroom remodeling, custom cabinetry"
            value={state.priorityServices}
            onChange={(e) => setField("priorityServices", e.target.value)}
            disabled={running}
            rows={3}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="negativeKeywords">
            Negative keywords / excluded services
          </Label>
          <Textarea
            id="negativeKeywords"
            placeholder="e.g. cheap, DIY, free quote"
            value={state.negativeKeywords}
            onChange={(e) => setField("negativeKeywords", e.target.value)}
            disabled={running}
            rows={2}
          />
          <p className="text-xs text-ink-3">
            Search terms or service categories you don&apos;t want associated
            with the business (e.g., &lsquo;cheap&rsquo;, &lsquo;DIY&rsquo;).
            Not Google Ads negative keywords.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="existingTargetKeywords">
            Existing target keywords (one per line, optional)
          </Label>
          <Textarea
            id="existingTargetKeywords"
            placeholder="kitchen remodel atlanta&#10;bathroom remodeling near me"
            value={state.existingTargetKeywords}
            onChange={(e) =>
              setField("existingTargetKeywords", e.target.value)
            }
            disabled={running}
            rows={4}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="idealCustomer">
            Ideal customer &amp; problems they need solved
          </Label>
          <Textarea
            id="idealCustomer"
            placeholder="Homeowners in their 40s-60s who are renovating to stay long-term, value craftsmanship over price, and need help making selections."
            value={state.idealCustomer}
            onChange={(e) => setField("idealCustomer", e.target.value)}
            disabled={running}
            rows={3}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="targetLocations">
            Target locations (optional, one per line — &ldquo;City, State&rdquo;)
          </Label>
          <Textarea
            id="targetLocations"
            placeholder={"Sarasota, FL\nBradenton, FL"}
            value={state.targetLocations}
            onChange={(e) => setField("targetLocations", e.target.value)}
            disabled={running}
            rows={3}
          />
          {state.targetLocations.trim() &&
          targetLocationsParsed.length === 0 ? (
            <p className="text-xs text-destructive">
              Could not parse any locations. Use &ldquo;City, ST&rdquo; or
              &ldquo;City, Full State&rdquo; per line.
            </p>
          ) : targetLocationsParsed.length === 0 ? (
            <p className="text-xs text-ink-3">
              No target locations — the audit will skip location-specific
              coverage findings.
            </p>
          ) : (
            <p className="text-xs text-ink-3">
              Parsed {targetLocationsParsed.length} location
              {targetLocationsParsed.length === 1 ? "" : "s"}.
            </p>
          )}
        </div>

        {validationError && !running && (
          <p className="text-sm text-destructive" role="alert">
            {validationError}
          </p>
        )}

        <div className="flex justify-end border-t pt-4">
          <Button type="button" onClick={runAudit} disabled={running}>
            {running ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />{" "}
                {stageDetail ??
                  STAGE_LABEL[stage as keyof typeof STAGE_LABEL] ??
                  "Running…"}
              </>
            ) : (
              "Run Audit"
            )}
          </Button>
        </div>
      </section>

      {errorMessage && !running && (
        <div
          role="alert"
          className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {errorMessage}
        </div>
      )}

      {auditResult && stage !== "idle" && (
        <AuditResult
          result={auditResult}
          auditId={lastAuditId}
          onDownload={downloadMarkdown}
        />
      )}
    </div>
  )
}

function AuditResult({
  result,
  auditId,
  onDownload,
}: {
  result: AssessmentAuditResult
  auditId: string | null
  onDownload: () => void
}) {
  const minutes = Math.max(1, Math.round(result.durationSeconds / 60))
  return (
    <section className="space-y-4">
      <div className="rounded-lg border bg-card p-5">
        <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
          <div>
            <h2 className="text-lg font-semibold">Audit ready</h2>
            <p className="text-sm text-ink-3">
              {result.websiteUrl} · generated in {minutes} minute
              {minutes === 1 ? "" : "s"} ·{" "}
              {result.gscData ? "GSC ✓" : "GSC —"} ·{" "}
              {result.ga4Data ? "GA4 ✓" : "GA4 —"} ·{" "}
              {result.crawlSummary?.pagesAnalyzed ?? 0} pages crawled
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {auditId ? (
              <Button asChild>
                <Link href={`/audits/${auditId}`}>
                  <ExternalLink className="mr-2 h-4 w-4" /> Open dashboard
                </Link>
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={onDownload}>
              <Download className="mr-2 h-4 w-4" /> Download as Markdown
            </Button>
          </div>
        </div>

        {result.warnings.length > 0 && (
          <div className="mt-4 space-y-1 rounded-md border border-amber-400/50 bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-900/20 dark:text-amber-200">
            <strong>Warnings</strong>
            <ul className="list-inside list-disc">
              {result.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <article className="rounded-lg border bg-card p-6">
        <p className="mb-4 font-serif text-[13.5px] italic text-ink-2">
          Markdown narrative shown below for reference. The interactive
          dashboard is the primary deliverable — open it via the button above.
        </p>
        <div className="prose prose-sm max-w-none dark:prose-invert prose-headings:font-sans prose-headings:font-extrabold prose-headings:tracking-[-0.005em] prose-h1:text-[24px] prose-h2:text-[18px] prose-h3:text-[15px] prose-strong:text-foreground">
          <ReactMarkdown rehypePlugins={[rehypeRaw]}>
            {result.auditMarkdown}
          </ReactMarkdown>
        </div>
      </article>
    </section>
  )
}
