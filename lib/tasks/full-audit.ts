import "server-only"
import { z } from "zod"
import { getPartner, saveArtifact } from "@/lib/partners"
import type { TaskRunner } from "@/lib/inngest/functions"
import { runAuditPipeline, type AuditInput } from "@/lib/tasks/audit"
import type { Partner, TargetMarket } from "@/lib/types"

/**
 * Full Audit task — scheduled-version sibling of the manual audit at
 * `/audit`. Reuses the same gather + synthesize pipeline (see
 * `runAuditPipeline`); the only difference is input source. Manual audits
 * carry freeform context fields (priorityServices, idealCustomer, etc.)
 * collected by the form. Scheduled audits read the website + service
 * areas off the partner's Airtable record and leave the freeform fields
 * blank — the audit pipeline degrades gracefully when those are empty.
 */

export const FullAuditInputSchema = z.object({
  partnerId: z.string().min(1),
})

export type FullAuditInput = z.infer<typeof FullAuditInputSchema>

const STATE_ABBR_TO_NAME: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
  MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina",
  ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee",
  TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia",
}
const STATE_NAMES = new Set(Object.values(STATE_ABBR_TO_NAME).map((n) => n.toLowerCase()))

/**
 * Best-effort parse of a partner's free-text `serviceAreas` field into the
 * `TargetMarket[]` shape the audit pipeline expects. Handles the common
 * cases seen in production data:
 *   "Greensboro and Winston Salem, North Carolina"
 *   "Peachtree City, GA"
 *   "Atlanta, Georgia"
 *   multi-line lists with one market per line
 * Returns an empty array when nothing parseable is found — the audit
 * pipeline accepts this and skips the targetMarkets-aware checks.
 */
export function parseServiceAreas(raw: string | null | undefined): TargetMarket[] {
  if (!raw) return []
  const out: TargetMarket[] = []
  const seen = new Set<string>()
  // Split on newlines and semicolons; each chunk is treated as one market
  // expression. We don't split on plain commas because "City, State" uses
  // a comma as the separator.
  const chunks = raw.split(/[\n;]+/).map((c) => c.trim()).filter(Boolean)
  for (const chunk of chunks) {
    // Pull a trailing state token. Match either a 2-letter abbrev or a
    // multi-word state name at the end of the chunk after a comma.
    const abbrMatch = chunk.match(/^(.+?),\s*([A-Za-z]{2})\.?$/)
    let state: string | null = null
    let cityPart: string | null = null
    if (abbrMatch) {
      const abbr = abbrMatch[2].toUpperCase()
      if (STATE_ABBR_TO_NAME[abbr]) {
        state = STATE_ABBR_TO_NAME[abbr]
        cityPart = abbrMatch[1]
      }
    }
    if (!state) {
      const nameMatch = chunk.match(/^(.+?),\s*([A-Za-z][A-Za-z .]+)$/)
      if (nameMatch && STATE_NAMES.has(nameMatch[2].trim().toLowerCase())) {
        state = nameMatch[2].trim()
        cityPart = nameMatch[1]
      }
    }
    if (!state || !cityPart) continue
    // City part may still contain "A and B" — split into multiple markets.
    const cities = cityPart
      .split(/\s+and\s+|,\s+/i)
      .map((c) => c.trim())
      .filter(Boolean)
    for (const city of cities) {
      const key = `${city.toLowerCase()}|${state.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ city, state })
      if (out.length >= 10) return out
    }
  }
  return out
}

function buildAuditInput(partner: Partner): AuditInput {
  return {
    websiteUrl: partner.website,
    partnerName: partner.name,
    priorityServices: "",
    negativeKeywords: "",
    existingTargetKeywords: "",
    idealCustomer: "",
    targetMarkets: parseServiceAreas(partner.serviceAreas),
    crawlMode: "full",
  }
}

export const runFullAuditTask: TaskRunner = async ({ jobId, job }) => {
  const parsed = FullAuditInputSchema.safeParse(job.input)
  if (!parsed.success) {
    throw new Error(
      `Invalid full-audit input: ${JSON.stringify(parsed.error.flatten())}`,
    )
  }
  const partner = await getPartner(parsed.data.partnerId).catch(() => null)
  if (!partner) {
    throw new Error(`Partner ${parsed.data.partnerId} not found`)
  }
  if (!partner.website || !partner.website.trim()) {
    throw new Error(
      `Partner ${partner.name} has no website on file; cannot run a full audit.`,
    )
  }
  const input = buildAuditInput(partner)
  const outcome = await runAuditPipeline(jobId, input)

  await saveArtifact({
    partnerId: partner.id,
    kind: "audit",
    title: `${partner.name} — Full audit`,
    data: {
      generatedAt: outcome.result.audit.generatedAt,
      durationSeconds: outcome.result.audit.durationSeconds,
      costUsd: outcome.result.costUsd,
      warnings: outcome.result.audit.warnings,
    },
    jobId,
  }).catch((err) => {
    console.warn(
      `[full-audit] failed to save artifact for partner ${partner.id}:`,
      err,
    )
  })

  return outcome
}
