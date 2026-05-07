"use client"

import { useCallback, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { JobsForKindCard } from "@/components/JobsForKindCard"
import { ensureNotificationPermission } from "@/components/JobsTray"
import { PageHeader } from "@/components/PageHeader"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useAssessment } from "@/lib/assessment-context"
import { useChatPageContext } from "@/lib/chat-context"
import { parseTargetLocationLines } from "@/lib/locations"

/**
 * Assessment Audit tab.
 *
 * Form-only screen now: submit fires a POST to /api/jobs/start which
 * enqueues an Inngest job, and the user is redirected to /audits/<jobId>
 * where the in-progress + completed views live. The full pipeline runs
 * detached from the request, so the user can navigate away, switch tabs,
 * or close the laptop and pick up via the Jobs tray (or the completion
 * email) when it finishes.
 *
 * Form fields are persisted in the shared Assessment context so the
 * Comp Analysis tab can pre-fill from them. Refreshing the page wipes
 * everything — that's intended.
 */

const URL_REGEX = /^(https?:\/\/)?[\w-]+(\.[\w-]+)+([/?#].*)?$/i

export default function AuditPage() {
  const router = useRouter()
  const { state, setField, setMany } = useAssessment()
  const [submitting, setSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [validationError, setValidationError] = useState<string | null>(null)

  const targetLocationsParsed = useMemo(
    () => parseTargetLocationLines(state.targetLocations),
    [state.targetLocations],
  )

  useChatPageContext("audit", {
    tab: "Audit",
    summary: [
      submitting ? "Starting audit job…" : "Audit form (idle).",
      validationError ? `Validation issue: ${validationError}.` : "",
      errorMessage ? `Last error: ${errorMessage}.` : "",
      targetLocationsParsed.length > 0
        ? `${targetLocationsParsed.length} target location(s) parsed.`
        : "",
    ]
      .filter(Boolean)
      .join(" "),
    data: {
      submitting,
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

  const startAudit = useCallback(async () => {
    const problem = validate()
    if (problem) {
      setValidationError(problem)
      return
    }
    setValidationError(null)
    setErrorMessage(null)
    setSubmitting(true)
    void ensureNotificationPermission()

    const websiteUrl = state.websiteUrl.trim()
    try {
      const res = await fetch("/api/jobs/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "audit",
          title: `Audit — ${websiteUrl}`,
          input: {
            websiteUrl,
            partnerName: state.partnerName.trim(),
            priorityServices: state.priorityServices,
            negativeKeywords: state.negativeKeywords,
            existingTargetKeywords: state.existingTargetKeywords,
            idealCustomer: state.idealCustomer,
            targetMarkets: targetLocationsParsed,
          },
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const { jobId } = (await res.json()) as { jobId: string }
      // Clear any stale audit context so the dashboard hydrates from the
      // job result rather than the previous run's data.
      setMany({ auditResult: null })
      toast.success("Audit started", {
        description: "We'll email you when it's ready.",
      })
      router.push(`/audits/${jobId}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error"
      setErrorMessage(`Could not start audit: ${message}`)
      toast.error("Audit failed to start", { description: message })
      setSubmitting(false)
    }
  }, [
    validate,
    state.websiteUrl,
    state.partnerName,
    state.priorityServices,
    state.negativeKeywords,
    state.existingTargetKeywords,
    state.idealCustomer,
    targetLocationsParsed,
    setMany,
    router,
  ])

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Assessments / Audit"
        title="SEO Audit"
        tail="— prospect evaluation"
        subtitle={
          <>
            Stateless audit for a prospective partner. Enter the prospect&apos;s
            business context and target locations; the audit runs as a
            background job, pulling{" "}
            <b className="font-sans font-extrabold not-italic text-foreground">
              GSC
            </b>{" "}
            and{" "}
            <b className="font-sans font-extrabold not-italic text-foreground">
              GA4
            </b>{" "}
            data through the assessments Google account, crawling the site,
            and synthesizing findings biased by the priorities you provide.
            You&apos;ll get an email when it&apos;s ready.
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
            disabled={submitting}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="partnerName">Business name (optional)</Label>
          <Input
            id="partnerName"
            placeholder="e.g. Example Landscaping"
            value={state.partnerName}
            onChange={(e) => setField("partnerName", e.target.value)}
            disabled={submitting}
          />
          <p className="text-xs text-ink-3">
            Used to detect when ChatGPT, Perplexity, Gemini, or Claude mention
            this business in answers to buyer-intent prompts. Leave blank to
            auto-derive from the domain.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="priorityServices">Priority services</Label>
          <Textarea
            id="priorityServices"
            placeholder="e.g. kitchen remodeling, bathroom remodeling, custom cabinetry"
            value={state.priorityServices}
            onChange={(e) => setField("priorityServices", e.target.value)}
            disabled={submitting}
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
            disabled={submitting}
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
            disabled={submitting}
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
            disabled={submitting}
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
            disabled={submitting}
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

        {validationError && !submitting && (
          <p className="text-sm text-destructive" role="alert">
            {validationError}
          </p>
        )}

        <div className="flex justify-end border-t pt-4">
          <Button type="button" onClick={startAudit} disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Starting…
              </>
            ) : (
              "Run Audit"
            )}
          </Button>
        </div>
      </section>

      {errorMessage && !submitting && (
        <div
          role="alert"
          className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {errorMessage}
        </div>
      )}

      <JobsForKindCard kind="audit" title="Recent audits" />
    </div>
  )
}
