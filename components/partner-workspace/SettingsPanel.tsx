"use client"

import { useEffect, useMemo, useState } from "react"
import { Loader2Icon } from "lucide-react"
import { toast } from "sonner"
import { GoogleMultiSelect } from "@/components/partner-workspace/GoogleMultiSelect"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type {
  GA4PropertyInfo,
  GoogleAccountSlug,
  GSCSiteInfo,
  Partner,
} from "@/lib/types"

interface GscSiteForAccount {
  account: GoogleAccountSlug
  site: GSCSiteInfo
}

interface Ga4PropertyForAccount {
  account: GoogleAccountSlug
  property: GA4PropertyInfo
}

type Selection = { id: string; account: GoogleAccountSlug }

export function SettingsPanel({
  partner,
  onUpdated,
}: {
  partner: Partner
  onUpdated: (p: Partner) => void
}) {
  const [name, setName] = useState(partner.name)
  const [website, setWebsite] = useState(partner.website)
  const [services, setServices] = useState(partner.services)
  const [serviceAreas, setServiceAreas] = useState(partner.serviceAreas)
  const [partnerGoals, setPartnerGoals] = useState(partner.partnerGoals ?? "")
  const [targetAudience, setTargetAudience] = useState(
    partner.targetAudience ?? "",
  )
  const [contentMarketing, setContentMarketing] = useState(
    partner.contentMarketing ?? "",
  )
  const [industryKnowledge, setIndustryKnowledge] = useState(
    partner.industryKnowledge ?? "",
  )
  const [gscSelections, setGscSelections] = useState<Selection[]>(
    (partner.gscSites ?? []).map((s) => ({
      id: s.siteUrl,
      account: s.account,
    })),
  )
  const [ga4Selections, setGa4Selections] = useState<Selection[]>(
    (partner.ga4Properties ?? []).map((p) => ({
      id: p.propertyId,
      account: p.account,
    })),
  )
  const [submitting, setSubmitting] = useState(false)

  const [gscSites, setGscSites] = useState<GscSiteForAccount[]>([])
  const [ga4Properties, setGa4Properties] = useState<Ga4PropertyForAccount[]>([])
  const [loadingGoogle, setLoadingGoogle] = useState(true)

  useEffect(() => {
    let cancelled = false
    const ac = new AbortController()
    Promise.all([
      fetch("/api/google/sites", { signal: ac.signal }).then((r) => r.json()),
      fetch("/api/google/properties", { signal: ac.signal }).then((r) =>
        r.json(),
      ),
    ])
      .then(([sites, properties]) => {
        if (cancelled) return
        if (Array.isArray(sites.sites)) setGscSites(sites.sites)
        if (Array.isArray(properties.properties))
          setGa4Properties(properties.properties)
      })
      .catch(() => {
        // Non-fatal — the existing chips still show; we just can't add new ones.
      })
      .finally(() => {
        if (!cancelled) setLoadingGoogle(false)
      })
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [])

  // Merge "already-selected" entries with the freshly-loaded option set so
  // selections survive even when the option isn't in the latest list (e.g.
  // the user lost access in Google but we still want to display the chip).
  const gscOptions = useMemo(() => {
    const fromApi = gscSites.map((entry) => ({
      id: entry.site.siteUrl,
      account: entry.account,
      label: entry.site.siteUrl,
    }))
    const seen = new Set(fromApi.map((o) => `${o.account}::${o.id}`))
    for (const sel of gscSelections) {
      const key = `${sel.account}::${sel.id}`
      if (!seen.has(key)) {
        fromApi.push({
          id: sel.id,
          account: sel.account,
          label: sel.id,
        })
        seen.add(key)
      }
    }
    return fromApi
  }, [gscSites, gscSelections])

  const ga4Options = useMemo(() => {
    const fromApi: Array<{
      id: string
      account: GoogleAccountSlug
      label: string
      sublabel?: string
    }> = ga4Properties.map((entry) => ({
      id: entry.property.propertyId,
      account: entry.account,
      label: entry.property.displayName,
      sublabel: entry.property.websiteUrl,
    }))
    const seen = new Set(fromApi.map((o) => `${o.account}::${o.id}`))
    for (const sel of ga4Selections) {
      const key = `${sel.account}::${sel.id}`
      if (!seen.has(key)) {
        fromApi.push({
          id: sel.id,
          account: sel.account,
          label: sel.id,
        })
        seen.add(key)
      }
    }
    return fromApi
  }, [ga4Properties, ga4Selections])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      const res = await fetch(
        `/api/partners/${encodeURIComponent(partner.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            website,
            services,
            serviceAreas,
            partnerGoals,
            targetAudience,
            contentMarketing,
            industryKnowledge,
            gscSites: gscSelections.map((s) => ({
              siteUrl: s.id,
              account: s.account,
            })),
            ga4Properties: ga4Selections.map((s) => ({
              propertyId: s.id,
              account: s.account,
            })),
          }),
        },
      )
      const body = (await res.json()) as { partner?: Partner; error?: string }
      if (!res.ok || !body.partner) {
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      toast.success("Partner updated")
      onUpdated(body.partner)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to update partner")
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete() {
    if (
      !confirm(
        `Delete ${partner.name}? This removes the partner record and all saved artifacts. This cannot be undone.`,
      )
    )
      return
    try {
      const res = await fetch(
        `/api/partners/${encodeURIComponent(partner.id)}`,
        { method: "DELETE" },
      )
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      toast.success("Partner deleted")
      window.location.href = "/partners"
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to delete partner")
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Settings</h2>
        <p className="text-sm text-muted-foreground">
          Edit this partner&rsquo;s profile and Google integrations.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="max-w-2xl space-y-5">
        <div className="space-y-2">
          <Label htmlFor="name">Partner name</Label>
          <Input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="website">Website</Label>
          <Input
            id="website"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            required
          />
        </div>

        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="services">Services</Label>
            <Textarea
              id="services"
              value={services}
              onChange={(e) => setServices(e.target.value)}
              rows={2}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="serviceAreas">Service areas</Label>
            <Textarea
              id="serviceAreas"
              value={serviceAreas}
              onChange={(e) => setServiceAreas(e.target.value)}
              rows={2}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <div className="space-y-2">
            <Label>GSC sites</Label>
            <GoogleMultiSelect
              options={gscOptions}
              value={gscSelections}
              onChange={setGscSelections}
              loading={loadingGoogle}
              itemNoun="site"
              itemNounPlural="sites"
            />
          </div>

          <div className="space-y-2">
            <Label>GA4 properties</Label>
            <GoogleMultiSelect
              options={ga4Options}
              value={ga4Selections}
              onChange={setGa4Selections}
              loading={loadingGoogle}
              itemNoun="property"
              itemNounPlural="properties"
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="partnerGoals">Partner goals</Label>
          <Textarea
            id="partnerGoals"
            value={partnerGoals}
            onChange={(e) => setPartnerGoals(e.target.value)}
            rows={3}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="targetAudience">Target audience</Label>
          <Textarea
            id="targetAudience"
            value={targetAudience}
            onChange={(e) => setTargetAudience(e.target.value)}
            rows={3}
          />
        </div>

        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="contentMarketing">Content marketing</Label>
            <Textarea
              id="contentMarketing"
              value={contentMarketing}
              onChange={(e) => setContentMarketing(e.target.value)}
              rows={3}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="industryKnowledge">Industry knowledge</Label>
            <Textarea
              id="industryKnowledge"
              value={industryKnowledge}
              onChange={(e) => setIndustryKnowledge(e.target.value)}
              rows={3}
            />
          </div>
        </div>

        <div className="flex items-center justify-between pt-2">
          <Button type="submit" disabled={submitting}>
            {submitting ? (
              <>
                <Loader2Icon className="mr-1.5 size-4 animate-spin" />
                Saving…
              </>
            ) : (
              "Save changes"
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={handleDelete}
            className="text-destructive hover:text-destructive"
          >
            Delete partner
          </Button>
        </div>
      </form>
    </div>
  )
}
