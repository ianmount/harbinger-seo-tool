import { NextResponse } from "next/server"
import {
  buildSynthesisPrompt,
  injectOrganicSessionsChart,
  SYNTHESIS_SYSTEM_PROMPT,
} from "@/lib/audit-synthesis"
import { callClaude, ClaudeApiError } from "@/lib/claude"
import type { AuditDataBundle } from "@/lib/types"

/**
 * Audit synthesis endpoint.
 *
 * Accepts an `AuditDataBundle` (produced by `/api/audit/run`), builds the
 * synthesis prompt, calls Claude Opus, post-processes the markdown
 * (YoY chart + sparkline injection), and returns
 * `{ auditMarkdown, synthesisDurationSeconds }`. The client combines this
 * with the gather bundle to build the final `AssessmentAuditResult`.
 *
 * Split out of `/api/audit/run` so each step gets its own 800s function
 * budget — full audits with Opus synthesis on big sites were bumping past
 * the cap.
 *
 * Body size note: the bundle can be 1-3MB on big sites. Vercel's default
 * serverless body cap is 4.5MB. If a real run trips that, switch the
 * gather → synthesize handoff to ID-based storage (KV / Blob).
 */
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 800

function isBundle(raw: unknown): raw is AuditDataBundle {
  if (!raw || typeof raw !== "object") return false
  const r = raw as Record<string, unknown>
  return (
    typeof r.websiteUrl === "string" &&
    typeof r.body === "object" &&
    r.body !== null &&
    typeof r.crawl === "object" &&
    r.crawl !== null
  )
}

export async function POST(request: Request) {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON" },
      { status: 400 },
    )
  }
  if (!isBundle(raw)) {
    return NextResponse.json(
      { error: "Request body must be an AuditDataBundle (websiteUrl + body + crawl required)" },
      { status: 400 },
    )
  }
  const bundle = raw

  const startedAt = Date.now()
  try {
    const prompt = buildSynthesisPrompt({
      body: {
        websiteUrl: bundle.body.websiteUrl,
        partnerName: bundle.body.partnerName,
        priorityServices: bundle.body.priorityServices,
        negativeKeywords: bundle.body.negativeKeywords,
        existingTargetKeywords: bundle.body.existingTargetKeywords,
        idealCustomer: bundle.body.idealCustomer,
        targetMarkets: bundle.body.targetMarkets,
      },
      gsc: bundle.gsc,
      ga4: bundle.ga4,
      crawl: bundle.crawl,
      cannibalization: bundle.cannibalization,
      pageSpeed: bundle.pageSpeed,
      backlinkProfile: bundle.backlinkProfile,
      urlStructureIssues: bundle.urlStructureIssues,
      brokenInternalLinks: bundle.brokenInternalLinks,
      metaUnreliable: bundle.metaUnreliable,
    })
    let auditMarkdown = await callClaude(prompt, {
      model: "claude-opus-4-7",
      system: SYNTHESIS_SYSTEM_PROMPT,
      maxTokens: 12_000,
    })
    auditMarkdown = injectOrganicSessionsChart(auditMarkdown, bundle.ga4)
    const synthesisDurationSeconds = Math.round((Date.now() - startedAt) / 1000)
    console.log(
      `[audit:synthesize] domain=${bundle.websiteUrl} duration=${synthesisDurationSeconds}s prompt_chars=${prompt.length} markdown_chars=${auditMarkdown.length}`,
    )
    return NextResponse.json({ auditMarkdown, synthesisDurationSeconds })
  } catch (err) {
    if (err instanceof ClaudeApiError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.status ?? 502 },
      )
    }
    const msg = err instanceof Error ? err.message : "Unknown synthesis error"
    return NextResponse.json(
      { error: `Claude synthesis failed: ${msg}` },
      { status: 502 },
    )
  }
}
