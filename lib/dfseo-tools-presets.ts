import type { Partner } from "@/lib/types"

/** One locked-down DFS tool invocation for a specific partner. */
export interface DfseoPreset {
  toolId: string
  label: string
  /** Params passed directly to /api/dataforseo/tools. */
  params: Record<string, unknown>
}

/** Strips protocol/trailing-slash from a partner website string. */
function domainFromWebsite(website: string): string {
  return website
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase()
}

/**
 * Returns the four locked-down DFS tool presets for a given partner.
 *
 * - Ranked Keywords: Labs endpoint, target = partner domain, no location (Labs
 *   is US/country-level only anyway; omitting location_code uses the DFS default).
 * - Backlinks List: as-is mode, live status, limit 1000.
 * - Lighthouse Audit: partner homepage, mobile mode on.
 * - LLM Mentions Search: domain target, any scope, US location, en language,
 *   limit 100. Platform left configurable by the caller.
 */
export function getPartnerDfseoPresets(partner: Partner): DfseoPreset[] {
  const domain = domainFromWebsite(partner.website)
  const homepage = partner.website.startsWith("http")
    ? partner.website.replace(/\/$/, "")
    : `https://${partner.website.replace(/\/$/, "")}`

  return [
    {
      toolId: "labs-ranked-keywords",
      label: "Ranked Keywords",
      params: {
        target: domain,
        location_code: 2840,
        language_code: "en",
        limit: 200,
        max_rank: 100,
      },
    },
    {
      toolId: "backlinks-list",
      label: "Backlinks List",
      params: {
        target: domain,
        limit: 1000,
        mode: "as_is",
        backlinks_status_type: "live",
      },
    },
    {
      toolId: "onpage-lighthouse",
      label: "Lighthouse Audit",
      params: {
        url: homepage,
        for_mobile: true,
      },
    },
    {
      toolId: "ai-llm-mentions-search",
      label: "LLM Mentions",
      params: {
        target_kind: "domain",
        target_value: domain,
        search_scope: "any",
        location_code: 2840,
        language_code: "en",
        limit: 100,
        // platform is intentionally omitted — caller should inject before running
      },
    },
  ]
}

/** LLM Mentions platform options exposed to the UI. */
export const LLM_PLATFORM_OPTIONS = [
  { value: "google", label: "Google AI Overviews" },
  { value: "chat_gpt", label: "ChatGPT" },
] as const

export type LlmPlatform = (typeof LLM_PLATFORM_OPTIONS)[number]["value"]
