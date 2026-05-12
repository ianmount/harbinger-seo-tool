"use client"

import { useCallback, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { JobsForKindCard } from "@/components/JobsForKindCard"
import { LocationAutocomplete } from "@/components/LocationAutocomplete"
import { PageHeader } from "@/components/PageHeader"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useChatPageContext } from "@/lib/chat-context"
import { cn } from "@/lib/utils"
import type { DfsLabsLocation } from "@/lib/types"

const DEPTH_PRESETS = [
  { id: "quick", label: "Quick", count: 25, blurb: "25 keywords. Fastest, cheapest." },
  { id: "standard", label: "Standard", count: 50, blurb: "50 keywords. Recommended default." },
  { id: "deep", label: "Deep", count: 100, blurb: "100 keywords. Thorough; slower SERP probing." },
  { id: "custom", label: "Custom", count: null, blurb: "Pick your own (10–100)." },
] as const

type PresetId = (typeof DEPTH_PRESETS)[number]["id"]

const DOMAIN_REGEX = /^[\w-]+(\.[\w-]+)+$/

function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
}

/** Split services typed as comma- or newline-separated. */
function parseServices(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 20)
}

/** Parse competitor domains, normalizing each. Empty if user didn't fill the field. */
function parseCompetitors(raw: string): string[] {
  return raw
    .split(/[\n,\s]+/)
    .map((d) => normalizeDomain(d))
    .filter((d) => d.length > 0 && DOMAIN_REGEX.test(d))
    .slice(0, 10)
}

export default function KeywordResearchPage() {
  const router = useRouter()
  const [domainInput, setDomainInput] = useState("")
  const [servicesInput, setServicesInput] = useState("")
  const [competitorsInput, setCompetitorsInput] = useState("")
  const [cities, setCities] = useState<DfsLabsLocation[]>([])
  const [preset, setPreset] = useState<PresetId>("standard")
  const [customCount, setCustomCount] = useState<string>("50")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const normalizedDomain = useMemo(
    () => normalizeDomain(domainInput),
    [domainInput],
  )
  const services = useMemo(() => parseServices(servicesInput), [servicesInput])
  const competitors = useMemo(
    () => parseCompetitors(competitorsInput),
    [competitorsInput],
  )

  const maxKeywords = useMemo(() => {
    if (preset === "custom") {
      const n = parseInt(customCount, 10)
      if (!Number.isFinite(n)) return 50
      return Math.min(100, Math.max(10, n))
    }
    return DEPTH_PRESETS.find((p) => p.id === preset)?.count ?? 50
  }, [preset, customCount])

  const ready =
    DOMAIN_REGEX.test(normalizedDomain) &&
    services.length > 0 &&
    cities.length > 0 &&
    maxKeywords >= 10

  useChatPageContext("keyword-research", {
    tab: "Keyword Research",
    summary: [
      normalizedDomain ? `Domain: ${normalizedDomain}.` : "No domain entered.",
      services.length > 0
        ? `${services.length} service(s).`
        : "No services entered.",
      cities.length > 0
        ? `${cities.length} location(s) selected.`
        : "No locations selected.",
      `Run depth: ${DEPTH_PRESETS.find((p) => p.id === preset)?.label} (${maxKeywords} keywords).`,
    ].join(" "),
    data: {
      domain: normalizedDomain || null,
      services,
      cities: cities.map((c) => ({
        code: c.location_code,
        name: c.location_name,
      })),
      maxKeywords,
    },
  })

  const addCity = useCallback((loc: DfsLabsLocation) => {
    setCities((prev) =>
      prev.some((l) => l.location_code === loc.location_code)
        ? prev
        : [...prev, loc],
    )
  }, [])

  const removeCity = useCallback((code: number) => {
    setCities((prev) => prev.filter((l) => l.location_code !== code))
  }, [])

  const handleRun = useCallback(async () => {
    if (!ready || submitting) return
    setError(null)
    setSubmitting(true)
    try {
      const res = await fetch("/api/jobs/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "keyword_research",
          title: `Keyword Research — ${normalizedDomain}`,
          // resultPath is set by the task itself once the run finishes
          // (lib/tasks/keyword-research.ts → /keyword-research/{jobId}).
          input: {
            domain: normalizedDomain,
            services,
            cities,
            maxKeywords,
            competitors: competitors.length > 0 ? competitors : undefined,
          },
        }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string
        }
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const { jobId } = (await res.json()) as { jobId: string }
      toast.success("Keyword research started", {
        description: "We'll email you when it's ready.",
      })
      router.push(`/keyword-research/${jobId}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error"
      setError(`Could not start research: ${msg}`)
      toast.error("Keyword research failed to start", { description: msg })
      setSubmitting(false)
    }
  }, [
    ready,
    submitting,
    normalizedDomain,
    services,
    cities,
    maxKeywords,
    competitors,
    router,
  ])

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Research"
        title="Keyword Research"
        tail="— pipeline"
        subtitle={
          <>
            Enter a partner domain, the services they sell, and the cities
            they serve. We pull competitor rankings, partner rankings, keyword
            ideas, related queries, difficulty, volume, and intent at country
            level; Claude shortlists the top {`{max}`} candidates; then we
            probe live city-level SERPs to capture current rankings. Runs as a
            background job — close the tab and check back later.
          </>
        }
      />

      <section className="space-y-5 rounded-lg border bg-card p-5">
        <div className="space-y-1.5">
          <Label htmlFor="domain">Partner domain</Label>
          <Input
            id="domain"
            placeholder="examplelandscaping.com"
            value={domainInput}
            onChange={(e) => setDomainInput(e.target.value)}
            disabled={submitting}
          />
          <p className="text-xs text-muted-foreground">
            Bare domain or full URL — we strip protocol/www/path.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="services">Services</Label>
          <Textarea
            id="services"
            rows={3}
            placeholder="plumbing&#10;drain cleaning&#10;water heater repair"
            value={servicesInput}
            onChange={(e) => setServicesInput(e.target.value)}
            disabled={submitting}
          />
          <p className="text-xs text-muted-foreground">
            Comma- or newline-separated. {services.length}/20 entries parsed.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="competitors">
            Competitors{" "}
            <span className="font-normal text-muted-foreground">
              (optional, recommended)
            </span>
          </Label>
          <Textarea
            id="competitors"
            rows={2}
            placeholder="acmeplumbing.com&#10;atlantaplumbingco.com"
            value={competitorsInput}
            onChange={(e) => setCompetitorsInput(e.target.value)}
            disabled={submitting}
          />
          <p className="text-xs text-muted-foreground">
            Comma- or newline-separated bare domains.{" "}
            {competitors.length > 0
              ? `${competitors.length}/10 valid domain${competitors.length === 1 ? "" : "s"} parsed.`
              : "Leave blank to auto-discover via DataForSEO — but manual entry produces sharper results, since auto-discovery surfaces national sites (Home Depot, etc.) by keyword overlap."}
          </p>
        </div>

        <div className="space-y-2">
          <LocationAutocomplete
            label="Target cities"
            selected={cities}
            onAdd={addCity}
            onRemove={removeCity}
            disabled={submitting}
            helpText={
              <>
                Cities only — country and state codes work for Phase 1 (national
                data) but the city-level SERP probes need a city
                (<span className="font-mono">location_type=City</span>) for
                meaningful results.
              </>
            }
          />
          {cities.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {cities.map((c) => (
                <Badge key={c.location_code} variant="secondary">
                  {c.location_name}
                </Badge>
              ))}
            </div>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label>Run depth</Label>
          <div className="flex flex-wrap gap-2">
            {DEPTH_PRESETS.map((p) => {
              const active = preset === p.id
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPreset(p.id)}
                  disabled={submitting}
                  aria-pressed={active}
                  className={cn(
                    "flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition-colors",
                    active
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-input bg-transparent text-muted-foreground hover:bg-muted/50",
                    submitting && "cursor-not-allowed opacity-60",
                  )}
                >
                  <span className="text-sm font-medium text-foreground">
                    {p.label}
                  </span>
                  <span className="text-xs">
                    {p.count != null ? `${p.count} keywords` : "10–100 (custom)"}
                  </span>
                </button>
              )
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            {DEPTH_PRESETS.find((p) => p.id === preset)?.blurb}
          </p>
          {preset === "custom" ? (
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={10}
                max={100}
                step={5}
                value={customCount}
                onChange={(e) => setCustomCount(e.target.value)}
                disabled={submitting}
                className="w-24"
              />
              <span className="text-xs text-muted-foreground">
                Resolves to {maxKeywords} keywords (clamped to 10–100).
              </span>
            </div>
          ) : null}
        </div>

        {error ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={handleRun} disabled={!ready || submitting}>
            {submitting ? "Starting…" : "Run Research"}
          </Button>
          <p className="text-xs text-muted-foreground">
            ~$0.40–$1.50 per run depending on depth × cities. SERP probes use
            the standard queue (cheap, async, ~10 min worst case).
          </p>
        </div>
      </section>

      <JobsForKindCard kind="keyword_research" title="Recent runs" />
    </div>
  )
}
