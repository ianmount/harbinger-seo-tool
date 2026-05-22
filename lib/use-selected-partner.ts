"use client"

import { useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"
import type { Partner } from "@/lib/types"

export interface UseSelectedPartnerResult {
  partner: Partner | null
  loading: boolean
  error: string | null
}

/**
 * Reads `partnerId` from the URL and fetches the corresponding partner
 * record. Returns null when no `partnerId` is present.
 *
 * Each tab page calls this hook independently, so the partner fetch runs
 * once per tab visit. No cross-tab cache for MVP — it's a cheap Airtable
 * lookup and keeps state simple.
 */
export function useSelectedPartner(): UseSelectedPartnerResult {
  const searchParams = useSearchParams()
  const partnerId = searchParams.get("partnerId")

  const [partner, setPartner] = useState<Partner | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!partnerId) {
      setPartner(null)
      setLoading(false)
      setError(null)
      return
    }

    let cancelled = false
    const abort = new AbortController()
    setLoading(true)
    setError(null)

    async function load() {
      try {
        const response = await fetch(
          `/api/partners/${encodeURIComponent(partnerId!)}`,
          { signal: abort.signal },
        )
        const body = (await response.json().catch(() => ({}))) as {
          partner?: Partner
          error?: string
        }
        if (!response.ok) {
          throw new Error(body.error ?? `HTTP ${response.status}`)
        }
        if (!cancelled) setPartner(body.partner ?? null)
      } catch (err: unknown) {
        if (cancelled || (err instanceof Error && err.name === "AbortError")) {
          return
        }
        setError(err instanceof Error ? err.message : "Failed to load partner")
        setPartner(null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => {
      cancelled = true
      abort.abort()
    }
  }, [partnerId])

  return { partner, loading, error }
}
