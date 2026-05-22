import "server-only"
import { getSupabase } from "@/lib/supabase"
import type {
  Ga4PropertyRef,
  GoogleAccountSlug,
  GscSiteRef,
  Partner,
  PartnerArtifact,
  PartnerArtifactKind,
  PartnerContextField,
} from "@/lib/types"

/**
 * Supabase-backed reader/writer for partner records.
 *
 * Source of truth for partners. Replaces lib/airtable.ts's read path.
 * Airtable is consulted only by the one-shot migration script at
 * scripts/migrate-airtable-partners.ts.
 *
 * All exported helpers return shapes that mirror the legacy Airtable
 * Partner interface so the ~11 existing call sites don't need to change
 * beyond swapping the import.
 */

interface PartnerRow {
  id: string
  name: string
  website: string
  services: string
  service_areas: string
  partner_goals: string | null
  target_audience: string | null
  content_marketing: string | null
  industry_knowledge: string | null
  gsc_site_url: string | null
  gsc_account: GoogleAccountSlug | null
  gsc_sites: GscSiteRef[] | null
  ga4_property_id: string | null
  ga4_account: GoogleAccountSlug | null
  ga4_properties: Ga4PropertyRef[] | null
  airtable_id: string | null
  unfilled_context: PartnerContextField[] | null
  created_at: string
  updated_at: string
}

function isGscRef(v: unknown): v is GscSiteRef {
  if (typeof v !== "object" || v === null) return false
  const r = v as Record<string, unknown>
  return (
    typeof r.siteUrl === "string" &&
    (r.account === "partners" || r.account === "assessments")
  )
}

function isGa4Ref(v: unknown): v is Ga4PropertyRef {
  if (typeof v !== "object" || v === null) return false
  const r = v as Record<string, unknown>
  return (
    typeof r.propertyId === "string" &&
    (r.account === "partners" || r.account === "assessments")
  )
}

/**
 * Returns the full list of GSC sites for a partner row, deriving from
 * the legacy scalar columns if the jsonb array isn't populated. This
 * keeps multi-property support working for rows that haven't been
 * migrated through a write path yet.
 */
function deriveGscSites(row: PartnerRow): GscSiteRef[] {
  if (Array.isArray(row.gsc_sites) && row.gsc_sites.length > 0) {
    return row.gsc_sites.filter(isGscRef)
  }
  if (row.gsc_site_url && row.gsc_account) {
    return [{ siteUrl: row.gsc_site_url, account: row.gsc_account }]
  }
  return []
}

function deriveGa4Properties(row: PartnerRow): Ga4PropertyRef[] {
  if (Array.isArray(row.ga4_properties) && row.ga4_properties.length > 0) {
    return row.ga4_properties.filter(isGa4Ref)
  }
  if (row.ga4_property_id && row.ga4_account) {
    return [{ propertyId: row.ga4_property_id, account: row.ga4_account }]
  }
  return []
}

interface PartnerArtifactRow {
  id: string
  partner_id: string
  kind: string
  title: string
  data: unknown
  blob_url: string | null
  job_id: string | null
  created_by_session: string | null
  created_at: string
}

function rowToPartner(row: PartnerRow): Partner {
  const gscSites = deriveGscSites(row)
  const ga4Properties = deriveGa4Properties(row)
  const primaryGsc = gscSites[0]
  const primaryGa4 = ga4Properties[0]
  return {
    id: row.id,
    name: row.name,
    website: row.website,
    services: row.services,
    serviceAreas: row.service_areas,
    partnerGoals: row.partner_goals ?? undefined,
    targetAudience: row.target_audience ?? undefined,
    contentMarketing: row.content_marketing ?? undefined,
    industryKnowledge: row.industry_knowledge ?? undefined,
    gscSites: gscSites.length > 0 ? gscSites : undefined,
    gscSiteUrl: primaryGsc?.siteUrl ?? row.gsc_site_url ?? undefined,
    gscAccount: primaryGsc?.account ?? row.gsc_account ?? undefined,
    ga4Properties: ga4Properties.length > 0 ? ga4Properties : undefined,
    ga4PropertyId:
      primaryGa4?.propertyId ?? row.ga4_property_id ?? undefined,
    ga4Account: primaryGa4?.account ?? row.ga4_account ?? undefined,
    airtableId: row.airtable_id ?? undefined,
    unfilledContext:
      row.unfilled_context && row.unfilled_context.length > 0
        ? row.unfilled_context
        : undefined,
  }
}

/**
 * Build the DB column payload from optional `gscSites` / `ga4Properties`
 * arrays. Always writes the scalar columns to mirror the first entry,
 * which keeps existing readers of `gsc_site_url` / `ga4_property_id`
 * working without changes.
 */
function buildIntegrationsPayload(input: {
  gscSites?: GscSiteRef[]
  ga4Properties?: Ga4PropertyRef[]
  // Legacy singular fields (used as fallback when arrays not provided):
  gscSiteUrl?: string
  gscAccount?: GoogleAccountSlug
  ga4PropertyId?: string
  ga4Account?: GoogleAccountSlug
}): Record<string, unknown> {
  const out: Record<string, unknown> = {}

  if (input.gscSites !== undefined) {
    const normalized = input.gscSites
      .map((s) => ({ siteUrl: s.siteUrl.trim(), account: s.account }))
      .filter((s) => s.siteUrl.length > 0)
    out.gsc_sites = normalized.length > 0 ? normalized : null
    out.gsc_site_url = normalized[0]?.siteUrl ?? null
    out.gsc_account = normalized[0]?.account ?? null
  } else {
    if (input.gscSiteUrl !== undefined) {
      const trimmed = input.gscSiteUrl.trim()
      out.gsc_site_url = trimmed || null
      if (!trimmed) out.gsc_sites = null
    }
    if (input.gscAccount !== undefined) out.gsc_account = input.gscAccount
  }

  if (input.ga4Properties !== undefined) {
    const normalized = input.ga4Properties
      .map((p) => ({ propertyId: p.propertyId.trim(), account: p.account }))
      .filter((p) => p.propertyId.length > 0)
    out.ga4_properties = normalized.length > 0 ? normalized : null
    out.ga4_property_id = normalized[0]?.propertyId ?? null
    out.ga4_account = normalized[0]?.account ?? null
  } else {
    if (input.ga4PropertyId !== undefined) {
      const trimmed = input.ga4PropertyId.trim()
      out.ga4_property_id = trimmed || null
      if (!trimmed) out.ga4_properties = null
    }
    if (input.ga4Account !== undefined) out.ga4_account = input.ga4Account
  }

  return out
}

function rowToArtifact(row: PartnerArtifactRow): PartnerArtifact {
  return {
    id: row.id,
    partnerId: row.partner_id,
    kind: row.kind as PartnerArtifactKind,
    title: row.title,
    data: row.data,
    blobUrl: row.blob_url ?? undefined,
    jobId: row.job_id ?? undefined,
    createdBySession: row.created_by_session ?? undefined,
    createdAt: row.created_at,
  }
}

/**
 * UUID v4 check. Used by getPartner so legacy callers that still pass an
 * Airtable record id ("recXXXX") can be transparently re-resolved via the
 * airtable_id column instead of hitting Supabase with a malformed UUID.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function getPartners(): Promise<Partner[]> {
  const { data, error } = await getSupabase()
    .from("partners")
    .select("*")
    .order("name", { ascending: true })
  if (error) {
    throw new Error(`Failed to list partners: ${error.message}`)
  }
  return (data ?? []).map((r) => rowToPartner(r as PartnerRow))
}

export async function getPartner(id: string): Promise<Partner | null> {
  const sb = getSupabase()
  const lookupColumn = UUID_RE.test(id) ? "id" : "airtable_id"
  const { data, error } = await sb
    .from("partners")
    .select("*")
    .eq(lookupColumn, id)
    .maybeSingle()
  if (error) {
    throw new Error(`Failed to fetch partner ${id}: ${error.message}`)
  }
  return data ? rowToPartner(data as PartnerRow) : null
}

export interface CreatePartnerInput {
  name: string
  website: string
  services?: string
  serviceAreas?: string
  partnerGoals?: string
  targetAudience?: string
  contentMarketing?: string
  industryKnowledge?: string
  /** Preferred: full list of GSC sites. */
  gscSites?: GscSiteRef[]
  /** Preferred: full list of GA4 properties. */
  ga4Properties?: Ga4PropertyRef[]
  /** Legacy singular fields. Used as a fallback when arrays aren't supplied. */
  gscSiteUrl?: string
  gscAccount?: GoogleAccountSlug
  ga4PropertyId?: string
  ga4Account?: GoogleAccountSlug
}

export async function createPartner(
  input: CreatePartnerInput,
): Promise<Partner> {
  const { data, error } = await getSupabase()
    .from("partners")
    .insert({
      name: input.name.trim(),
      website: input.website.trim(),
      services: input.services?.trim() ?? "",
      service_areas: input.serviceAreas?.trim() ?? "",
      partner_goals: input.partnerGoals?.trim() || null,
      target_audience: input.targetAudience?.trim() || null,
      content_marketing: input.contentMarketing?.trim() || null,
      industry_knowledge: input.industryKnowledge?.trim() || null,
      ...buildIntegrationsPayload(input),
    })
    .select("*")
    .single()
  if (error || !data) {
    throw new Error(`Failed to create partner: ${error?.message ?? "unknown"}`)
  }
  return rowToPartner(data as PartnerRow)
}

export type UpdatePartnerInput = Partial<CreatePartnerInput>

export async function updatePartner(
  id: string,
  input: UpdatePartnerInput,
): Promise<Partner> {
  const patch: Record<string, unknown> = {}
  if (input.name !== undefined) patch.name = input.name.trim()
  if (input.website !== undefined) patch.website = input.website.trim()
  if (input.services !== undefined) patch.services = input.services.trim()
  if (input.serviceAreas !== undefined)
    patch.service_areas = input.serviceAreas.trim()
  if (input.partnerGoals !== undefined)
    patch.partner_goals = input.partnerGoals.trim() || null
  if (input.targetAudience !== undefined)
    patch.target_audience = input.targetAudience.trim() || null
  if (input.contentMarketing !== undefined)
    patch.content_marketing = input.contentMarketing.trim() || null
  if (input.industryKnowledge !== undefined)
    patch.industry_knowledge = input.industryKnowledge.trim() || null

  Object.assign(patch, buildIntegrationsPayload(input))

  if (Object.keys(patch).length === 0) {
    const existing = await getPartner(id)
    if (!existing) throw new Error(`Partner ${id} not found`)
    return existing
  }

  const { data, error } = await getSupabase()
    .from("partners")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single()
  if (error || !data) {
    throw new Error(`Failed to update partner ${id}: ${error?.message ?? "not found"}`)
  }
  return rowToPartner(data as PartnerRow)
}

export async function deletePartner(id: string): Promise<void> {
  const { error } = await getSupabase().from("partners").delete().eq("id", id)
  if (error) {
    throw new Error(`Failed to delete partner ${id}: ${error.message}`)
  }
}

/**
 * Upsert by airtable_id. Used by the one-shot migration script. Safe to
 * re-run: existing rows with the same airtable_id get updated, new ones
 * get inserted.
 */
export async function upsertPartnerByAirtableId(
  airtableId: string,
  input: CreatePartnerInput & { unfilledContext?: PartnerContextField[] },
): Promise<Partner> {
  const { data, error } = await getSupabase()
    .from("partners")
    .upsert(
      {
        airtable_id: airtableId,
        name: input.name.trim(),
        website: input.website.trim(),
        services: input.services?.trim() ?? "",
        service_areas: input.serviceAreas?.trim() ?? "",
        partner_goals: input.partnerGoals?.trim() || null,
        target_audience: input.targetAudience?.trim() || null,
        content_marketing: input.contentMarketing?.trim() || null,
        industry_knowledge: input.industryKnowledge?.trim() || null,
        unfilled_context: input.unfilledContext ?? null,
        ...buildIntegrationsPayload(input),
      },
      { onConflict: "airtable_id" },
    )
    .select("*")
    .single()
  if (error || !data) {
    throw new Error(
      `Failed to upsert partner for airtable_id ${airtableId}: ${error?.message ?? "unknown"}`,
    )
  }
  return rowToPartner(data as PartnerRow)
}

// ── Artifacts ──────────────────────────────────────────────────────────────

export interface SaveArtifactInput {
  partnerId: string
  kind: PartnerArtifactKind
  title: string
  data?: unknown
  blobUrl?: string
  jobId?: string
  sessionId?: string
}

export async function saveArtifact(
  input: SaveArtifactInput,
): Promise<PartnerArtifact> {
  const { data, error } = await getSupabase()
    .from("partner_artifacts")
    .insert({
      partner_id: input.partnerId,
      kind: input.kind,
      title: input.title.trim(),
      data: input.data ?? {},
      blob_url: input.blobUrl ?? null,
      job_id: input.jobId ?? null,
      created_by_session: input.sessionId ?? null,
    })
    .select("*")
    .single()
  if (error || !data) {
    throw new Error(`Failed to save artifact: ${error?.message ?? "unknown"}`)
  }
  return rowToArtifact(data as PartnerArtifactRow)
}

export async function listArtifacts(params: {
  partnerId: string
  kind?: PartnerArtifactKind
  limit?: number
}): Promise<PartnerArtifact[]> {
  let query = getSupabase()
    .from("partner_artifacts")
    .select("*")
    .eq("partner_id", params.partnerId)
    .order("created_at", { ascending: false })
  if (params.kind) query = query.eq("kind", params.kind)
  if (params.limit) query = query.limit(params.limit)
  const { data, error } = await query
  if (error) {
    throw new Error(`Failed to list artifacts: ${error.message}`)
  }
  return (data ?? []).map((r) => rowToArtifact(r as PartnerArtifactRow))
}

export async function getArtifact(id: string): Promise<PartnerArtifact | null> {
  const { data, error } = await getSupabase()
    .from("partner_artifacts")
    .select("*")
    .eq("id", id)
    .maybeSingle()
  if (error) {
    throw new Error(`Failed to fetch artifact ${id}: ${error.message}`)
  }
  return data ? rowToArtifact(data as PartnerArtifactRow) : null
}

export async function deleteArtifact(id: string): Promise<void> {
  const { error } = await getSupabase()
    .from("partner_artifacts")
    .delete()
    .eq("id", id)
  if (error) {
    throw new Error(`Failed to delete artifact ${id}: ${error.message}`)
  }
}
