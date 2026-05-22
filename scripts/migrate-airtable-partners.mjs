#!/usr/bin/env node

/**
 * One-shot migration: copy partner records from Airtable into Supabase.
 *
 * Idempotent. Re-running upserts by airtable_id, so re-runs only update
 * fields that changed in Airtable (and surface new partners). Existing
 * Supabase columns like gsc_account / ga4_account are preserved when not
 * overwritten — this script sets ga4_account = 'partners' for every row
 * (the legacy default), and only sets gsc_site_url if Airtable provides
 * one (none today; the field doesn't exist there).
 *
 * Prereqs (env via .env.local or shell):
 *   AIRTABLE_PAT
 *   AIRTABLE_BASE_ID
 *   AIRTABLE_PARTNERS_TABLE
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Run:
 *   node --env-file=.env.local scripts/migrate-airtable-partners.mjs
 *
 * Output: one line per partner. Final summary with inserted vs. updated counts.
 *
 * After this script succeeds, run the SQL block at the bottom of
 * supabase/schema.sql one more time (Supabase Dashboard → SQL Editor →
 * paste the file → Run) so the partner_id rewrites in crawl_runs and
 * task_schedules execute against the freshly-populated airtable_id values.
 */

import { createClient } from "@supabase/supabase-js"
import Airtable from "airtable"

function requireEnv(name) {
  const v = process.env[name]
  if (!v || v.trim() === "") {
    console.error(`Missing env var: ${name}`)
    process.exit(1)
  }
  return v
}

function stripProfileSuffix(name) {
  return name.replace(/\s*\|\s*Profile\s*$/i, "").trim()
}

function isTemplateBoilerplate(value) {
  if (!value) return false
  return /^\s*\*{0,2}template\*{0,2}\b/i.test(value)
}

function coerceField(v) {
  if (v == null) return undefined
  if (Array.isArray(v)) return v.length > 0 ? v.join(", ") : undefined
  const trimmed = String(v).trim()
  return trimmed.length > 0 ? trimmed : undefined
}

async function main() {
  const airtablePat = requireEnv("AIRTABLE_PAT")
  const airtableBase = requireEnv("AIRTABLE_BASE_ID")
  const airtableTable = requireEnv("AIRTABLE_PARTNERS_TABLE")
  const supabaseUrl = requireEnv("SUPABASE_URL")
  const supabaseKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY")

  const base = new Airtable({ apiKey: airtablePat }).base(airtableBase)
  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  console.log(`[migrate] Fetching partners from Airtable table "${airtableTable}"…`)
  const records = await base(airtableTable).select().all()
  console.log(`[migrate] Found ${records.length} Airtable records.`)

  let inserted = 0
  let updated = 0
  let skipped = 0
  const errors = []

  for (const record of records) {
    const fields = record.fields
    const profile = coerceField(fields["Profile"])
    const services = coerceField(fields["Services"])
    const serviceAreas = coerceField(fields["Service Areas"])
    const website = coerceField(fields["Website"])

    if (!profile || !services || !serviceAreas || !website) {
      console.warn(
        `[migrate] Skipping malformed record ${record.id} (missing required field)`,
      )
      skipped++
      continue
    }

    const partnerGoals = coerceField(fields["Partner Goals"])
    const targetAudience = coerceField(fields["Target Audience"])
    const contentMarketing = coerceField(fields["Content Marketing"])
    const industryKnowledge = coerceField(fields["Industry Knowledge"])
    const ga4PropertyId = coerceField(fields["GA4 Property ID"])

    const candidates = [
      ["services", services],
      ["serviceAreas", serviceAreas],
      ["partnerGoals", partnerGoals],
      ["targetAudience", targetAudience],
      ["contentMarketing", contentMarketing],
      ["industryKnowledge", industryKnowledge],
    ]
    const unfilledContext = candidates
      .filter(([, value]) => isTemplateBoilerplate(value))
      .map(([field]) => field)

    const name = stripProfileSuffix(profile)

    // Look up existing row by airtable_id so we can distinguish insert vs. update.
    const { data: existing } = await supabase
      .from("partners")
      .select("id")
      .eq("airtable_id", record.id)
      .maybeSingle()

    const payload = {
      airtable_id: record.id,
      name,
      website,
      services,
      service_areas: serviceAreas,
      partner_goals: partnerGoals ?? null,
      target_audience: targetAudience ?? null,
      content_marketing: contentMarketing ?? null,
      industry_knowledge: industryKnowledge ?? null,
      ga4_property_id: ga4PropertyId ?? null,
      // Legacy convention: every Airtable partner runs through the
      // GOOGLE_REFRESH_TOKEN_PARTNERS identity. Re-run after onboarding
      // new partners via the tool — those will have ga4_account set
      // explicitly by the create flow.
      ga4_account: "partners",
      gsc_account: "partners",
      unfilled_context: unfilledContext.length > 0 ? unfilledContext : null,
    }

    const { error } = await supabase
      .from("partners")
      .upsert(payload, { onConflict: "airtable_id" })

    if (error) {
      console.error(
        `[migrate] ✗ ${name} (${record.id}): ${error.message}`,
      )
      errors.push({ id: record.id, name, message: error.message })
      continue
    }

    if (existing) {
      updated++
      console.log(`[migrate] ↻ ${name}`)
    } else {
      inserted++
      console.log(`[migrate] + ${name}`)
    }
  }

  console.log()
  console.log(`[migrate] Done.`)
  console.log(`         inserted: ${inserted}`)
  console.log(`         updated:  ${updated}`)
  console.log(`         skipped:  ${skipped}`)
  console.log(`         errors:   ${errors.length}`)

  if (errors.length > 0) {
    console.error()
    console.error(`[migrate] Errors:`)
    for (const e of errors) {
      console.error(`  - ${e.name} (${e.id}): ${e.message}`)
    }
    process.exit(1)
  }

  console.log()
  console.log(
    `Next step: re-run supabase/schema.sql in the Supabase SQL editor so the`,
  )
  console.log(
    `partner_id rewrite block at the bottom maps existing crawl_runs and`,
  )
  console.log(`task_schedules rows from Airtable ids to the new Supabase UUIDs.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
