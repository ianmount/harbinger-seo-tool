"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ArrowLeftIcon, Loader2Icon } from "lucide-react"
import { toast } from "sonner"
import { PageHeader } from "@/components/PageHeader"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import type { GA4PropertyInfo, GoogleAccountSlug, GSCSiteInfo } from "@/lib/types"

interface GscSiteForAccount {
  account: GoogleAccountSlug
  site: GSCSiteInfo
}

interface Ga4PropertyForAccount {
  account: GoogleAccountSlug
  property: GA4PropertyInfo
}

interface GoogleListState<T> {
  status: "loading" | "ready" | "error"
  items: T[]
  errors: { account: GoogleAccountSlug; message: string }[]
  errorMessage?: string
}

const NONE_VALUE = "__none__"

function selectionKey(account: GoogleAccountSlug, id: string): string {
  return `${account}::${id}`
}

function parseSelection(
  value: string,
): { account: GoogleAccountSlug; id: string } | null {
  if (!value || value === NONE_VALUE) return null
  const [account, ...rest] = value.split("::")
  if (account !== "partners" && account !== "assessments") return null
  return { account, id: rest.join("::") }
}

export default function OnboardPartnerPage() {
  const router = useRouter()

  const [name, setName] = useState("")
  const [website, setWebsite] = useState("")
  const [services, setServices] = useState("")
  const [serviceAreas, setServiceAreas] = useState("")
  const [partnerGoals, setPartnerGoals] = useState("")
  const [targetAudience, setTargetAudience] = useState("")
  const [contentMarketing, setContentMarketing] = useState("")
  const [industryKnowledge, setIndustryKnowledge] = useState("")
  const [gscSelection, setGscSelection] = useState<string>(NONE_VALUE)
  const [ga4Selection, setGa4Selection] = useState<string>(NONE_VALUE)

  const [submitting, setSubmitting] = useState(false)

  const [gscState, setGscState] = useState<GoogleListState<GscSiteForAccount>>({
    status: "loading",
    items: [],
    errors: [],
  })
  const [ga4State, setGa4State] = useState<
    GoogleListState<Ga4PropertyForAccount>
  >({
    status: "loading",
    items: [],
    errors: [],
  })

  useEffect(() => {
    let cancelled = false
    const ac = new AbortController()
    async function loadSites() {
      try {
        const res = await fetch("/api/google/sites", { signal: ac.signal })
        const body = (await res.json()) as {
          sites?: GscSiteForAccount[]
          errors?: { account: GoogleAccountSlug; message: string }[]
          error?: string
        }
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
        if (!cancelled)
          setGscState({
            status: "ready",
            items: body.sites ?? [],
            errors: body.errors ?? [],
          })
      } catch (err: unknown) {
        if (cancelled || (err instanceof Error && err.name === "AbortError"))
          return
        setGscState({
          status: "error",
          items: [],
          errors: [],
          errorMessage:
            err instanceof Error ? err.message : "Failed to load GSC sites",
        })
      }
    }
    async function loadProperties() {
      try {
        const res = await fetch("/api/google/properties", { signal: ac.signal })
        const body = (await res.json()) as {
          properties?: Ga4PropertyForAccount[]
          errors?: { account: GoogleAccountSlug; message: string }[]
          error?: string
        }
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
        if (!cancelled)
          setGa4State({
            status: "ready",
            items: body.properties ?? [],
            errors: body.errors ?? [],
          })
      } catch (err: unknown) {
        if (cancelled || (err instanceof Error && err.name === "AbortError"))
          return
        setGa4State({
          status: "error",
          items: [],
          errors: [],
          errorMessage:
            err instanceof Error ? err.message : "Failed to load GA4 properties",
        })
      }
    }
    loadSites()
    loadProperties()
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [])

  const gscByAccount = useMemo(() => groupBy(gscState.items, (x) => x.account), [
    gscState.items,
  ])
  const ga4ByAccount = useMemo(() => groupBy(ga4State.items, (x) => x.account), [
    ga4State.items,
  ])

  const canSubmit =
    !submitting && name.trim().length > 0 && website.trim().length > 0

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    const gsc = parseSelection(gscSelection)
    const ga4 = parseSelection(ga4Selection)
    try {
      const res = await fetch("/api/partners", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          website: website.trim(),
          services: services.trim(),
          serviceAreas: serviceAreas.trim(),
          partnerGoals: partnerGoals.trim() || undefined,
          targetAudience: targetAudience.trim() || undefined,
          contentMarketing: contentMarketing.trim() || undefined,
          industryKnowledge: industryKnowledge.trim() || undefined,
          gscSiteUrl: gsc?.id,
          gscAccount: gsc?.account,
          ga4PropertyId: ga4?.id,
          ga4Account: ga4?.account,
        }),
      })
      const body = (await res.json()) as {
        partner?: { id: string; name: string }
        error?: string
      }
      if (!res.ok || !body.partner) {
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      toast.success(`${body.partner.name} onboarded`)
      router.push(`/partners/${body.partner.id}`)
    } catch (err: unknown) {
      setSubmitting(false)
      toast.error(
        err instanceof Error ? err.message : "Failed to create partner",
      )
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Link
          href="/partners"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4" />
          All Partners
        </Link>
      </div>

      <PageHeader
        eyebrow="Partners / Onboard"
        title="Onboard Partner"
        tail="— add a new partner to the tool."
        subtitle={
          <>
            Profile fields drive every downstream tool. Pick the GSC site and
            GA4 property from{" "}
            <b className="font-sans font-extrabold not-italic text-foreground">
              either authorized Google account
            </b>
            ; we record which account owns the integration so reports pull from
            the right place.
          </>
        }
      />

      <form onSubmit={handleSubmit} className="max-w-2xl space-y-5">
        <div className="space-y-2">
          <Label htmlFor="name">Partner name</Label>
          <Input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoComplete="off"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="website">Website</Label>
          <Input
            id="website"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            placeholder="https://example.com"
            required
            autoComplete="off"
          />
        </div>

        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="services">Services</Label>
            <Textarea
              id="services"
              value={services}
              onChange={(e) => setServices(e.target.value)}
              placeholder="HVAC, plumbing, electrical"
              rows={2}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="serviceAreas">Service areas</Label>
            <Textarea
              id="serviceAreas"
              value={serviceAreas}
              onChange={(e) => setServiceAreas(e.target.value)}
              placeholder="Atlanta, GA; Marietta, GA"
              rows={2}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="gsc">Google Search Console site</Label>
            <Select value={gscSelection} onValueChange={setGscSelection}>
              <SelectTrigger id="gsc" className="w-full">
                <SelectValue
                  placeholder={
                    gscState.status === "loading"
                      ? "Loading sites…"
                      : "Select a site (optional)"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_VALUE}>
                  Skip — link later
                </SelectItem>
                {(["partners", "assessments"] as const).map((account) => {
                  const items = gscByAccount[account] ?? []
                  if (items.length === 0) return null
                  return (
                    <SelectGroup key={account}>
                      <SelectLabel>
                        {account === "partners"
                          ? "Partners account"
                          : "Assessments account"}
                      </SelectLabel>
                      {items.map((entry) => (
                        <SelectItem
                          key={selectionKey(entry.account, entry.site.siteUrl)}
                          value={selectionKey(entry.account, entry.site.siteUrl)}
                        >
                          {entry.site.siteUrl}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )
                })}
              </SelectContent>
            </Select>
            <GoogleListWarnings
              state={gscState}
              label="GSC"
              emptyMessage="No GSC sites visible to either account."
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="ga4">GA4 property</Label>
            <Select value={ga4Selection} onValueChange={setGa4Selection}>
              <SelectTrigger id="ga4" className="w-full">
                <SelectValue
                  placeholder={
                    ga4State.status === "loading"
                      ? "Loading properties…"
                      : "Select a property (optional)"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_VALUE}>
                  Skip — link later
                </SelectItem>
                {(["partners", "assessments"] as const).map((account) => {
                  const items = ga4ByAccount[account] ?? []
                  if (items.length === 0) return null
                  return (
                    <SelectGroup key={account}>
                      <SelectLabel>
                        {account === "partners"
                          ? "Partners account"
                          : "Assessments account"}
                      </SelectLabel>
                      {items.map((entry) => (
                        <SelectItem
                          key={selectionKey(
                            entry.account,
                            entry.property.propertyId,
                          )}
                          value={selectionKey(
                            entry.account,
                            entry.property.propertyId,
                          )}
                        >
                          {entry.property.displayName}
                          {entry.property.websiteUrl
                            ? ` — ${entry.property.websiteUrl}`
                            : ""}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )
                })}
              </SelectContent>
            </Select>
            <GoogleListWarnings
              state={ga4State}
              label="GA4"
              emptyMessage="No GA4 properties visible to either account."
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="partnerGoals">Partner goals (optional)</Label>
          <Textarea
            id="partnerGoals"
            value={partnerGoals}
            onChange={(e) => setPartnerGoals(e.target.value)}
            rows={3}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="targetAudience">Target audience (optional)</Label>
          <Textarea
            id="targetAudience"
            value={targetAudience}
            onChange={(e) => setTargetAudience(e.target.value)}
            rows={3}
          />
        </div>

        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="contentMarketing">
              Content marketing (optional)
            </Label>
            <Textarea
              id="contentMarketing"
              value={contentMarketing}
              onChange={(e) => setContentMarketing(e.target.value)}
              rows={3}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="industryKnowledge">
              Industry knowledge (optional)
            </Label>
            <Textarea
              id="industryKnowledge"
              value={industryKnowledge}
              onChange={(e) => setIndustryKnowledge(e.target.value)}
              rows={3}
            />
          </div>
        </div>

        <div className="flex items-center gap-3 pt-2">
          <Button type="submit" disabled={!canSubmit}>
            {submitting ? (
              <>
                <Loader2Icon className="mr-1.5 size-4 animate-spin" />
                Creating…
              </>
            ) : (
              "Onboard partner"
            )}
          </Button>
          <Link
            href="/partners"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  )
}

function groupBy<T>(
  items: T[],
  keyFn: (item: T) => GoogleAccountSlug,
): Record<GoogleAccountSlug, T[]> {
  const out: Record<GoogleAccountSlug, T[]> = { partners: [], assessments: [] }
  for (const item of items) {
    out[keyFn(item)].push(item)
  }
  return out
}

function GoogleListWarnings<T>({
  state,
  label,
  emptyMessage,
}: {
  state: GoogleListState<T>
  label: string
  emptyMessage: string
}) {
  if (state.status === "error") {
    return (
      <p className="text-xs text-destructive">
        {label} unavailable: {state.errorMessage}
      </p>
    )
  }
  if (state.status === "ready") {
    if (state.items.length === 0 && state.errors.length > 0) {
      return (
        <p className="text-xs text-amber-600">
          {emptyMessage} (
          {state.errors.map((e) => e.account).join(" + ")} not configured)
        </p>
      )
    }
    if (state.items.length === 0) {
      return <p className="text-xs text-muted-foreground">{emptyMessage}</p>
    }
    if (state.errors.length > 0) {
      return (
        <p className="text-xs text-amber-600">
          {state.errors.map((e) => `${e.account}: ${e.message}`).join(" • ")}
        </p>
      )
    }
  }
  return null
}
