import "server-only"
import { Resend } from "resend"
import { env } from "@/lib/env"
import { KIND_LABELS, type JobRow } from "@/lib/jobs"

let cached: Resend | null = null

function getClient(): Resend | null {
  if (!env.RESEND_API_KEY) return null
  if (!cached) cached = new Resend(env.RESEND_API_KEY)
  return cached
}

/**
 * Build the public URL for a result. Prefer the explicit `result_path` set
 * by the task (e.g. `/audits/abc123`) — fall back to `/jobs/<id>` which
 * shows raw status + JSON.
 */
function resultUrl(job: JobRow): string {
  const base = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "http://localhost:3000"
  return job.result_path ? `${base}${job.result_path}` : `${base}/jobs/${job.id}`
}

/**
 * Send a "your job finished" email. Best-effort: returns silently if Resend
 * isn't configured (RESEND_API_KEY / NOTIFY_EMAIL / EMAIL_FROM unset). The
 * caller should never gate completion on the email succeeding — log and move
 * on. Inngest's step.run() ensures we don't double-send on retries.
 */
export async function sendJobCompletionEmail(job: JobRow): Promise<void> {
  const client = getClient()
  if (!client) {
    console.warn(
      `[email] RESEND_API_KEY unset; skipping completion email for job ${job.id}`,
    )
    return
  }
  const to = env.NOTIFY_EMAIL
  const from = env.EMAIL_FROM
  if (!to || !from) {
    console.warn(
      `[email] NOTIFY_EMAIL or EMAIL_FROM unset; skipping email for job ${job.id}`,
    )
    return
  }

  const kindLabel = KIND_LABELS[job.kind]
  const url = resultUrl(job)
  const isFail = job.status === "failed"
  const subject = isFail
    ? `${kindLabel} failed — ${job.title}`
    : `${kindLabel} complete — ${job.title}`

  const html = isFail
    ? buildFailureHtml(job, kindLabel, url)
    : buildSuccessHtml(job, kindLabel, url)

  try {
    await client.emails.send({ from, to, subject, html })
  } catch (err) {
    // Don't fail the job because email failed.
    console.error(`[email] Resend send failed for job ${job.id}:`, err)
  }
}

function buildSuccessHtml(job: JobRow, kindLabel: string, url: string): string {
  return `
<!doctype html>
<html><body style="font-family: -apple-system, system-ui, sans-serif; color: #03293A; padding: 24px;">
  <h2 style="margin: 0 0 8px;">${escape(kindLabel)} complete</h2>
  <p style="margin: 0 0 16px; color: #4a5460;">${escape(job.title)}</p>
  <p style="margin: 0 0 24px;">
    <a href="${url}" style="display: inline-block; background: #03293A; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: bold;">View results</a>
  </p>
  <p style="margin: 0; font-size: 12px; color: #8a929c;">Sent by Harbinger SEO Tool.</p>
</body></html>`
}

function buildFailureHtml(job: JobRow, kindLabel: string, url: string): string {
  const errMsg = job.error ?? "(no error message)"
  return `
<!doctype html>
<html><body style="font-family: -apple-system, system-ui, sans-serif; color: #03293A; padding: 24px;">
  <h2 style="margin: 0 0 8px; color: #b71c1c;">${escape(kindLabel)} failed</h2>
  <p style="margin: 0 0 16px; color: #4a5460;">${escape(job.title)}</p>
  <pre style="background: #f6f7f9; padding: 12px; border-radius: 6px; font-size: 12px; white-space: pre-wrap; word-break: break-word;">${escape(errMsg)}</pre>
  <p style="margin: 24px 0 0;"><a href="${url}" style="color: #03293A;">Open in tool</a></p>
</body></html>`
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}
