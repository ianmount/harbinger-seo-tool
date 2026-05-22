"use client"

import { useCallback, useEffect, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { Partner } from "@/lib/types"

type FetchState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; partners: Partner[] }

export function PartnerSelector() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const selectedId = searchParams.get("partnerId") ?? ""

  const [state, setState] = useState<FetchState>({ status: "loading" })

  useEffect(() => {
    let cancelled = false
    const abort = new AbortController()
    setState({ status: "loading" })

    async function load() {
      try {
        const response = await fetch("/api/partners", {
          signal: abort.signal,
        })
        const body = (await response.json().catch(() => ({}))) as {
          partners?: Partner[]
          error?: string
        }
        if (!response.ok) {
          throw new Error(body.error ?? `HTTP ${response.status}`)
        }
        const partners = (body.partners ?? []).slice().sort((a, b) =>
          a.name.localeCompare(b.name),
        )
        if (!cancelled) setState({ status: "ready", partners })
      } catch (err: unknown) {
        if (cancelled || (err instanceof Error && err.name === "AbortError")) {
          return
        }
        const message =
          err instanceof Error ? err.message : "Failed to load partners"
        setState({ status: "error", message })
      }
    }

    load()
    return () => {
      cancelled = true
      abort.abort()
    }
  }, [])

  const handleChange = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString())
      if (value) params.set("partnerId", value)
      else params.delete("partnerId")
      const query = params.toString()
      router.replace(query ? `${pathname}?${query}` : pathname, {
        scroll: false,
      })
    },
    [pathname, router, searchParams],
  )

  if (state.status === "error") {
    return (
      <p
        role="alert"
        className="text-sm text-destructive max-w-[260px] truncate"
        title={state.message}
      >
        Partners unavailable: {state.message}
      </p>
    )
  }

  const loading = state.status === "loading"
  const partners = state.status === "ready" ? state.partners : []
  const placeholder = loading
    ? "Loading partners…"
    : partners.length === 0
      ? "No partners found"
      : "Select a partner…"

  return (
    <Select
      value={selectedId}
      onValueChange={handleChange}
      disabled={loading || partners.length === 0}
    >
      <SelectTrigger className="w-[260px]" aria-label="Select partner">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {partners.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {p.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
