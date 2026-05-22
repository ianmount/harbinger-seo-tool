"use client"

import { useEffect, useState } from "react"
import { Loader2Icon } from "lucide-react"
import { toast } from "sonner"
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
import type {
  GA4PropertyInfo,
  GoogleAccountSlug,
  GSCSiteInfo,
  Partner,
} from "@/lib/types"

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

interface GscSiteForAccount {
  account: GoogleAccountSlug
  site: GSCSiteInfo
}

interface Ga4PropertyForAccount {
  account: GoogleAccountSlug
  property: GA4PropertyInfo
}

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
  const [gscSelection, setGscSelection] = useState<string>(
    partner.gscSiteUrl && partner.gscAccount
      ? selectionKey(partner.gscAccount, partner.gscSiteUrl)
      : NONE_VALUE,
  )
  const [ga4Selection, setGa4Selection] = useState<string>(
    partner.ga4PropertyId && partner.ga4Account
      ? selectionKey(partner.ga4Account, partner.ga4PropertyId)
      : NONE_VALUE,
  )
  const [submitting, setSubmitting] = useState(false)

  const [gscSites, setGscSites] = useState<GscSiteForAccount[]>([])
  const [ga4Properties, setGa4Properties] = useState<Ga4PropertyForAccount[]>([])

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
        // Non-fatal — the existing selection still shows; we just can't change it.
      })
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    const gsc = parseSelection(gscSelection)
    const ga4 = parseSelection(ga4Selection)
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
            gscSiteUrl: gsc?.id ?? "",
            gscAccount: gsc?.account,
            ga4PropertyId: ga4?.id ?? "",
            ga4Account: ga4?.account,
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

  const gscByAccount: Record<GoogleAccountSlug, GscSiteForAccount[]> = {
    partners: gscSites.filter((s) => s.account === "partners"),
    assessments: gscSites.filter((s) => s.account === "assessments"),
  }
  const ga4ByAccount: Record<GoogleAccountSlug, Ga4PropertyForAccount[]> = {
    partners: ga4Properties.filter((p) => p.account === "partners"),
    assessments: ga4Properties.filter((p) => p.account === "assessments"),
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
            <Label htmlFor="gsc">GSC site</Label>
            <Select value={gscSelection} onValueChange={setGscSelection}>
              <SelectTrigger id="gsc" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_VALUE}>None</SelectItem>
                {(["partners", "assessments"] as const).map((account) => {
                  const items = gscByAccount[account]
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
          </div>

          <div className="space-y-2">
            <Label htmlFor="ga4">GA4 property</Label>
            <Select value={ga4Selection} onValueChange={setGa4Selection}>
              <SelectTrigger id="ga4" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_VALUE}>None</SelectItem>
                {(["partners", "assessments"] as const).map((account) => {
                  const items = ga4ByAccount[account]
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
