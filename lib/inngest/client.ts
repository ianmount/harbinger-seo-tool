import "server-only"
import { Inngest } from "inngest"

/**
 * Singleton Inngest client. The id is the slug Inngest Cloud uses to identify
 * this app — keep it stable across deploys. Both INNGEST_EVENT_KEY (for
 * inngest.send()) and INNGEST_SIGNING_KEY (for the serve handler) are
 * auto-injected by the Vercel Marketplace integration in production. They
 * may be unset locally; the SDK will fall back to the local Inngest dev
 * server when present.
 */
export const inngest = new Inngest({
  id: "harbinger-seo-tool",
  // Reading env directly here (not via @/lib/env) because the Inngest SDK
  // checks process.env itself when the option is omitted; we just want to
  // pass it explicitly so the value participates in tree-shaking.
  eventKey: process.env.INNGEST_EVENT_KEY,
})

/**
 * Event payload shape — every background job rides on a single event with
 * `{ jobId }` in its data. The Inngest function looks up the job in
 * Supabase, dispatches based on `kind`, and runs the matching task
 * implementation. Keeping the wire format minimal means we only retransmit
 * jobIds, not the full input blob.
 */
export interface JobRunEvent {
  name: "jobs/run"
  data: {
    jobId: string
  }
}
