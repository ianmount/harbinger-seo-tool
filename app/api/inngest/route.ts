import { serve } from "inngest/next"
import { inngest } from "@/lib/inngest/client"
import { inngestFunctions } from "@/lib/inngest/functions"

/**
 * Inngest serve handler. The Inngest Vercel Marketplace integration POSTs
 * here on every deploy to register / sync this app's functions, and Inngest
 * Cloud invokes this endpoint when an event matches a registered trigger.
 *
 * Public path: must be whitelisted in `proxy.ts` since the auth cookie won't
 * be present on Inngest's invocation. Inngest's signing key (verified by
 * the SDK against `INNGEST_SIGNING_KEY`) authenticates the caller instead.
 *
 * `maxDuration` matches the longest task we expect to run — Audit at 800s
 * (Vercel Pro Fluid Compute ceiling). Tasks that go longer would need to be
 * split into Inngest steps, which the runner already supports.
 */
export const maxDuration = 800

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: inngestFunctions,
})
