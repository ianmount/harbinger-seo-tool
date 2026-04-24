import "server-only"
import Airtable, { type FieldSet, type Record as AirtableRecord } from "airtable"
import { z } from "zod"
import { requireEnv } from "@/lib/env"
import type { Partner, PartnerContextField } from "@/lib/types"

// Airtable multi-select/lookup fields return arrays; text fields return strings.
// User asked that multi-value fields be exposed as strings, so coerce arrays to
// a comma-joined string. Missing values become undefined.
const stringOrJoinedArray = z
  .union([z.string(), z.array(z.string()), z.undefined(), z.null()])
  .transform((v) => {
    if (v == null) return undefined
    if (Array.isArray(v)) return v.length > 0 ? v.join(", ") : undefined
    const trimmed = v.trim()
    return trimmed.length > 0 ? trimmed : undefined
  })

const requiredString = stringOrJoinedArray.refine(
  (v): v is string => typeof v === "string" && v.length > 0,
  { message: "field is required but empty or missing" },
)

const partnerFieldsSchema = z.object({
  Profile: requiredString,
  Services: requiredString,
  "Service Areas": requiredString,
  Website: requiredString,
  "Partner Goals": stringOrJoinedArray,
  "Target Audience": stringOrJoinedArray,
  "Content Marketing": stringOrJoinedArray,
  "Industry Knowledge": stringOrJoinedArray,
  "GA4 Property ID": stringOrJoinedArray,
})

type ParsedFields = z.infer<typeof partnerFieldsSchema>

// Every partner record in Airtable carries its name as "<Business> | Profile".
// Strip the suffix so UIs get the plain business name.
function stripProfileSuffix(name: string): string {
  return name.replace(/\s*\|\s*Profile\s*$/i, "").trim()
}

// Airtable records created from the shared template ship with placeholder
// blocks that begin with "**Template**". Flag any field still holding that
// boilerplate so the UI can warn the user before piping it to Claude.
function isTemplateBoilerplate(value: string | undefined): boolean {
  if (!value) return false
  return /^\s*\*{0,2}template\*{0,2}\b/i.test(value)
}

function toPartner(id: string, parsed: ParsedFields): Partner {
  const candidates: Array<[PartnerContextField, string | undefined]> = [
    ["services", parsed.Services],
    ["serviceAreas", parsed["Service Areas"]],
    ["partnerGoals", parsed["Partner Goals"]],
    ["targetAudience", parsed["Target Audience"]],
    ["contentMarketing", parsed["Content Marketing"]],
    ["industryKnowledge", parsed["Industry Knowledge"]],
  ]
  const unfilledContext = candidates
    .filter(([, value]) => isTemplateBoilerplate(value))
    .map(([field]) => field)

  return {
    id,
    name: stripProfileSuffix(parsed.Profile),
    services: parsed.Services,
    serviceAreas: parsed["Service Areas"],
    website: parsed.Website,
    partnerGoals: parsed["Partner Goals"],
    targetAudience: parsed["Target Audience"],
    contentMarketing: parsed["Content Marketing"],
    industryKnowledge: parsed["Industry Knowledge"],
    ga4PropertyId: parsed["GA4 Property ID"],
    ...(unfilledContext.length > 0 ? { unfilledContext } : {}),
  }
}

function tryParseRecord(
  record: AirtableRecord<FieldSet>,
): Partner | null {
  const result = partnerFieldsSchema.safeParse(record.fields)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ")
    console.warn(
      `[airtable] Skipping malformed partner record ${record.id}: ${issues}`,
    )
    return null
  }
  return toPartner(record.id, result.data)
}

let cachedTable: ReturnType<Airtable["base"]> | null = null

function getTable() {
  if (cachedTable) return cachedTable
  const pat = requireEnv("AIRTABLE_PAT")
  const baseId = requireEnv("AIRTABLE_BASE_ID")
  const base = new Airtable({ apiKey: pat }).base(baseId)
  cachedTable = base
  return base
}

function getPartnersTable() {
  const base = getTable()
  const tableName = requireEnv("AIRTABLE_PARTNERS_TABLE")
  return base(tableName)
}

export async function getPartners(): Promise<Partner[]> {
  const records = await getPartnersTable().select().all()
  const partners: Partner[] = []
  for (const record of records) {
    const partner = tryParseRecord(record)
    if (partner) partners.push(partner)
  }
  return partners
}

export async function getPartner(recordId: string): Promise<Partner | null> {
  try {
    const record = await getPartnersTable().find(recordId)
    return tryParseRecord(record)
  } catch (error: unknown) {
    // Airtable throws AirtableError with statusCode; a missing record is 404.
    if (
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      (error as { statusCode: number }).statusCode === 404
    ) {
      return null
    }
    throw error
  }
}
