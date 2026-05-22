"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ArrowLeftIcon, Loader2Icon } from "lucide-react"
import { toast } from "sonner"
import { PageHeader } from "@/components/PageHeader"
import { GoogleMultiSelect } from "@/components/partner-workspace/GoogleMultiSelect"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type {
  GA4PropertyInfo,
  GoogleAccountSlug,
  GSCSiteInfo,
} from "@/lib/types"

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

type Selection = { id: string; account: GoogleAccountSlug }

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
  const [gscSelections, setGscSelections] = useState<Selection[]>([])
  const [ga4Selections, setGa4Selections] = useState<Selection[]>([])

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

  const gscOptions = useMemo(
    () =>
      gscState.items.map((entry) => ({
        id: entry.site.siteUrl,
        account: entry.account,
        label: entry.site.siteUrl,
      })),
    [gscState.items],
  )

  const ga4Options = useMemo(
    () =>
      ga4State.items.map((entry) => ({
        id: entry.property.propertyId,
        account: entry.account,
        label: entry.property.displayName,
        sublabel: entry.property.websiteUrl,
      })),
    [ga4State.items],
  )

  const canSubmit =
    !submitting && name.trim().length > 0 && website.trim().length > 0

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
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
          gscSites: gscSelections.map((s) => ({
            siteUrl: s.id,
            account: s.account,
          })),
          ga4Properties: ga4Selections.map((s) => ({
            propertyId: s.id,
            account: s.account,
          })),
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
            Profile fields drive every downstream tool. Link as many GSC
            sites and GA4 properties as the partner owns, pulled from{" "}
            <b className="font-sans font-extrabold not-italic text-foreground">
              either authorized Google account
            </b>
            ; we record which account owns each one so reports pull from the
            right place.
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
            <Label>Google Search Console sites</Label>
            <GoogleMultiSelect
              options={gscOptions}
              value={gscSelections}
              onChange={setGscSelections}
              loading={gscState.status === "loading"}
              itemNoun="site"
              itemNounPlural="sites"
              helperText={
                <GoogleListWarnings
                  state={gscState}
                  emptyMessage="No GSC sites visible to either account."
                />
              }
            />
          </div>

          <div className="space-y-2">
            <Label>GA4 properties</Label>
            <GoogleMultiSelect
              options={ga4Options}
              value={ga4Selections}
              onChange={setGa4Selections}
              loading={ga4State.status === "loading"}
              itemNoun="property"
              itemNounPlural="properties"
              helperText={
                <GoogleListWarnings
                  state={ga4State}
                  emptyMessage="No GA4 properties visible to either account."
                />
              }
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

function GoogleListWarnings<T>({
  state,
  emptyMessage,
}: {
  state: GoogleListState<T>
  emptyMessage: string
}) {
  if (state.status === "error") {
    return (
      <span className="text-destructive">Unavailable: {state.errorMessage}</span>
    )
  }
  if (state.status === "ready") {
    if (state.items.length === 0 && state.errors.length > 0) {
      return (
        <span className="text-amber-600">
          {emptyMessage} (
          {state.errors.map((e) => e.account).join(" + ")} reported errors)
        </span>
      )
    }
    if (state.items.length === 0) {
      return <span>{emptyMessage}</span>
    }
    if (state.errors.length > 0) {
      return (
        <span className="text-amber-600">
          {state.errors.map((e) => `${e.account}: ${e.message}`).join(" • ")}
        </span>
      )
    }
  }
  return null
}
