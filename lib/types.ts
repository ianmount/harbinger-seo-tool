/**
 * Shared TypeScript types.
 *
 * Partner mirrors the Airtable schema as agreed with the user on 2026-04-23:
 *   - "Profile"             → name (required; trailing " | Profile" stripped)
 *   - "Services"            → services (required)
 *   - "Service Areas"       → serviceAreas (required)
 *   - "Website"             → website (required)
 *   - "Partner Goals"       → partnerGoals (optional)
 *   - "Target Audience"     → targetAudience (optional)
 *   - "Content Marketing"   → contentMarketing (optional)
 *   - "Industry Knowledge"  → industryKnowledge (optional)
 *
 * Airtable does not yet have a dedicated GSC siteUrl field, so the GSC client
 * derives it from `website` (URL-prefix format, e.g. "https://example.com/").
 * When a dedicated field is added, extend Partner with `gscSiteUrl?: string`.
 *
 * `unfilledContext` lists property names whose source Airtable field still
 * contains the record-template boilerplate (text starting with "**Template**").
 * UIs that feed partner context to Claude should surface a warning so users
 * know to fill those fields in Airtable before running strategy/content.
 */
export type PartnerContextField =
  | "services"
  | "serviceAreas"
  | "partnerGoals"
  | "targetAudience"
  | "contentMarketing"
  | "industryKnowledge"

export interface Partner {
  id: string
  name: string
  services: string
  serviceAreas: string
  website: string
  partnerGoals?: string
  targetAudience?: string
  contentMarketing?: string
  industryKnowledge?: string
  unfilledContext?: PartnerContextField[]
}
