"use client"

import type { AssessmentAuditResult, CompAnalysisLocationRows } from "@/lib/types"

/**
 * Session-scoped storage for completed audit results so the dashboard route
 * `/audits/[audit_id]` can read them after navigation.
 *
 * No database in scope (see CLAUDE.md → MVP scope). Results live in
 * `sessionStorage` keyed by a generated audit id; they survive in-tab
 * navigation but not a tab close, which mirrors the AssessmentProvider's
 * "refresh wipes everything" behavior.
 */

const STORAGE_PREFIX = "harbinger:audit:"
const INDEX_KEY = "harbinger:audit:index"
const MAX_AUDITS = 8

export interface StoredAudit {
  id: string
  result: AssessmentAuditResult
  /** Optional comp-analysis snapshot from the same session. */
  compAnalysisRows?: CompAnalysisLocationRows[] | null
  /** Free-text label the user can enter into the audit form. */
  partnerName?: string
  /** Plain text echoes from the audit form, for the dashboard header. */
  priorityServices?: string
  idealCustomer?: string
  /** ISO timestamp the entry was written. */
  storedAt: string
}

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.sessionStorage !== "undefined"
}

function readIndex(): string[] {
  if (!isBrowser()) return []
  try {
    const raw = window.sessionStorage.getItem(INDEX_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === "string") : []
  } catch {
    return []
  }
}

function writeIndex(ids: string[]): void {
  if (!isBrowser()) return
  try {
    window.sessionStorage.setItem(INDEX_KEY, JSON.stringify(ids))
  } catch {
    // Storage full — silently drop the index update. Individual entries
    // may still be readable if they were written before the failure.
  }
}

export function saveAudit(entry: StoredAudit): void {
  if (!isBrowser()) return
  try {
    window.sessionStorage.setItem(
      STORAGE_PREFIX + entry.id,
      JSON.stringify(entry),
    )
    const idx = readIndex().filter((id) => id !== entry.id)
    idx.unshift(entry.id)
    while (idx.length > MAX_AUDITS) {
      const evict = idx.pop()
      if (evict) window.sessionStorage.removeItem(STORAGE_PREFIX + evict)
    }
    writeIndex(idx)
  } catch {
    // Quota exceeded — best-effort only.
  }
}

export function loadAudit(id: string): StoredAudit | null {
  if (!isBrowser()) return null
  try {
    const raw = window.sessionStorage.getItem(STORAGE_PREFIX + id)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredAudit
    if (!parsed || typeof parsed !== "object" || !parsed.result) return null
    return parsed
  } catch {
    return null
  }
}

export function listAudits(): { id: string; storedAt: string; websiteUrl: string }[] {
  if (!isBrowser()) return []
  const ids = readIndex()
  const out: { id: string; storedAt: string; websiteUrl: string }[] = []
  for (const id of ids) {
    const entry = loadAudit(id)
    if (entry) {
      out.push({
        id: entry.id,
        storedAt: entry.storedAt,
        websiteUrl: entry.result.websiteUrl,
      })
    }
  }
  return out
}
