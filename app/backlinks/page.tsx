"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  MailIcon,
} from "lucide-react"
import { PageHeader } from "@/components/PageHeader"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useSelectedPartner } from "@/lib/use-selected-partner"
import { cn } from "@/lib/utils"
import type {
  CategorizedProspect,
  OutreachEmail,
  OutreachPriority,
  Partner,
  ProspectCategory,
  ReferringDomain,
} from "@/lib/types"

type Phase =
  | { status: "idle" }
  | { status: "fetching-backlinks" }
  | { status: "categorizing"; count: number }
  | { status: "done"; stats: ResearchStats }
  | { status: "error"; message: string }

interface ResearchStats {
  competitors: number
  totalFetched: number
  deduped: number
  afterFilter: number
  scored: number
}

type PriorityFilter = OutreachPriority | "__all__"
type CategoryFilter = ProspectCategory | "__all__"

const PRIORITY_ORDER: Record<OutreachPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
}

const CATEGORY_LABELS: Record<ProspectCategory, string> = {
  citation: "Citation",
  resource_page: "Resource page",
  editorial: "Editorial",
  supplier: "Supplier",
  other: "Other",
}

const MAX_COMPETITORS = 10
const DEFAULT_LIMIT_PER_COMPETITOR = 100

function parseCompetitors(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) =>
      s.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase(),
    )
    .filter((s) => s.length > 0)
}

function csvEscape(value: unknown): string {
  if (value == null) return ""
  const s = String(value)
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

function buildProspectsCsv(rows: CategorizedProspect[]): string {
  const headers = [
    "Domain",
    "Category",
    "Priority",
    "Rank",
    "Backlinks",
    "Spam Score",
    "Linking To Competitor",
    "Angle",
    "Reasoning",
    "First Seen",
  ]
  const lines = [headers.join(",")]
  for (const r of rows) {
    lines.push(
      [
        csvEscape(r.domain),
        csvEscape(r.category),
        csvEscape(r.outreachPriority),
        csvEscape(r.rank),
        csvEscape(r.backlinks),
        csvEscape(r.spamScore),
        csvEscape(r.referringTo),
        csvEscape(r.angle),
        csvEscape(r.reasoning),
        csvEscape(r.firstSeen ?? ""),
      ].join(","),
    )
  }
  return lines.join("\n")
}

function downloadCsv(rows: CategorizedProspect[], partnerName: string) {
  const csv = buildProspectsCsv(rows)
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  const slug = partnerName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
  const stamp = new Date().toISOString().slice(0, 10)
  a.href = url
  a.download = `${slug || "partner"}-backlink-prospects-${stamp}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

async function fetchJson<T>(
  url: string,
  init: RequestInit,
  friendly: string,
): Promise<T> {
  const response = await fetch(url, init)
  const body = (await response.json().catch(() => ({}))) as {
    error?: string
  } & T
  if (!response.ok) {
    throw new Error(body.error ?? `${friendly} failed (${response.status})`)
  }
  return body
}

export default function BacklinksPage() {
  const { partner, loading: partnerLoading, error: partnerError } =
    useSelectedPartner()
  const [competitorsText, setCompetitorsText] = useState("")
  const [phase, setPhase] = useState<Phase>({ status: "idle" })
  const [prospects, setProspects] = useState<CategorizedProspect[]>([])
  const [priorityFilter, setPriorityFilter] =
    useState<PriorityFilter>("__all__")
  const [categoryFilter, setCategoryFilter] =
    useState<CategoryFilter>("__all__")

  useEffect(() => {
    // Reset state when partner changes. The URL param drives partner
    // selection, so this is a sync from external state into component state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPhase({ status: "idle" })
    setProspects([])
    setCompetitorsText("")
    setPriorityFilter("__all__")
    setCategoryFilter("__all__")
  }, [partner?.id])

  const competitors = useMemo(
    () => parseCompetitors(competitorsText).slice(0, MAX_COMPETITORS),
    [competitorsText],
  )

  const running =
    phase.status === "fetching-backlinks" || phase.status === "categorizing"

  const handleRun = useCallback(async () => {
    if (!partner) return
    if (competitors.length === 0) {
      setPhase({
        status: "error",
        message:
          "Add at least one competitor domain (one per line or comma separated).",
      })
      return
    }

    setPhase({ status: "fetching-backlinks" })
    let backlinksBody: {
      prospects: ReferringDomain[]
      stats: {
        totalFetched: number
        deduped: number
        afterFilter: number
      }
    }
    try {
      backlinksBody = await fetchJson<{
        prospects: ReferringDomain[]
        stats: {
          totalFetched: number
          deduped: number
          afterFilter: number
        }
      }>(
        "/api/dataforseo/backlinks",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            competitors,
            limit: DEFAULT_LIMIT_PER_COMPETITOR,
          }),
        },
        "DataForSEO backlinks",
      )
    } catch (err) {
      setPhase({
        status: "error",
        message:
          err instanceof Error
            ? err.message
            : "DataForSEO backlinks request failed",
      })
      return
    }

    if (backlinksBody.prospects.length === 0) {
      setPhase({
        status: "error",
        message: `No prospects passed the spam / rank filters. Try different competitors or widen the pool.`,
      })
      return
    }

    setPhase({
      status: "categorizing",
      count: backlinksBody.prospects.length,
    })
    try {
      const categorized = await fetchJson<{ prospects: CategorizedProspect[] }>(
        "/api/claude/prospects",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            partner,
            prospects: backlinksBody.prospects,
          }),
        },
        "Claude prospect categorization",
      )
      setProspects(categorized.prospects)
      setPhase({
        status: "done",
        stats: {
          competitors: competitors.length,
          totalFetched: backlinksBody.stats.totalFetched,
          deduped: backlinksBody.stats.deduped,
          afterFilter: backlinksBody.stats.afterFilter,
          scored: categorized.prospects.length,
        },
      })
    } catch (err) {
      setPhase({
        status: "error",
        message:
          err instanceof Error
            ? err.message
            : "Claude categorization failed",
      })
    }
  }, [partner, competitors])

  const filtered = useMemo(() => {
    return prospects.filter((p) => {
      if (priorityFilter !== "__all__" && p.outreachPriority !== priorityFilter)
        return false
      if (categoryFilter !== "__all__" && p.category !== categoryFilter)
        return false
      return true
    })
  }, [prospects, priorityFilter, categoryFilter])

  const sorted = useMemo(() => {
    return filtered.slice().sort((a, b) => {
      const pri = PRIORITY_ORDER[a.outreachPriority] - PRIORITY_ORDER[b.outreachPriority]
      if (pri !== 0) return pri
      return b.rank - a.rank
    })
  }, [filtered])

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Workflow / Backlinks"
        title="Backlinks"
        tail="— prospects from competitor link graphs."
        subtitle={
          <>
            Pull referring&#8209;domain lists from{" "}
            <b className="font-sans font-extrabold not-italic text-foreground">
              3–5 competitors
            </b>
            , filter for quality, and have{" "}
            <b className="font-sans font-extrabold not-italic text-foreground">
              Claude
            </b>{" "}
            categorize each prospect so you can prioritize outreach.
          </>
        }
      />

      {partnerLoading ? (
        <p className="text-sm text-muted-foreground">Loading partner…</p>
      ) : partnerError ? (
        <p className="text-sm text-destructive" role="alert">
          {partnerError}
        </p>
      ) : !partner ? (
        <p className="text-sm text-muted-foreground">
          Please select a partner from the dropdown above.
        </p>
      ) : (
        <>
          <ResearchForm
            competitorsText={competitorsText}
            onCompetitorsChange={setCompetitorsText}
            parsedCompetitors={competitors}
            onRun={handleRun}
            running={running}
            phase={phase}
          />

          <PhaseStatus phase={phase} />

          {phase.status === "done" && prospects.length > 0 ? (
            <ResultsSection
              partner={partner}
              prospects={prospects}
              filtered={sorted}
              priorityFilter={priorityFilter}
              categoryFilter={categoryFilter}
              onPriorityChange={setPriorityFilter}
              onCategoryChange={setCategoryFilter}
              stats={phase.stats}
            />
          ) : null}
        </>
      )}
    </div>
  )
}

function ResearchForm({
  competitorsText,
  onCompetitorsChange,
  parsedCompetitors,
  onRun,
  running,
  phase,
}: {
  competitorsText: string
  onCompetitorsChange: (v: string) => void
  parsedCompetitors: string[]
  onRun: () => void
  running: boolean
  phase: Phase
}) {
  return (
    <section className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="competitors">Competitor domains</Label>
        <Textarea
          id="competitors"
          placeholder="e.g. competitor-one.com&#10;competitor-two.com&#10;competitor-three.com"
          value={competitorsText}
          onChange={(e) => onCompetitorsChange(e.target.value)}
          className="min-h-[110px] font-mono text-sm"
          disabled={running}
        />
        <p className="text-xs text-muted-foreground">
          One domain per line or comma separated. Drop the{" "}
          <code className="font-mono">https://</code> and any path — just the
          hostname. First {MAX_COMPETITORS} are used per run.{" "}
          {parsedCompetitors.length > 0
            ? `Using (${parsedCompetitors.length}): ${parsedCompetitors.join(", ")}`
            : null}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          onClick={onRun}
          disabled={running || parsedCompetitors.length === 0}
        >
          {phase.status === "fetching-backlinks"
            ? "Fetching referring domains…"
            : phase.status === "categorizing"
              ? "Categorizing with Claude…"
              : "Research Prospects"}
        </Button>
        <p className="text-xs text-muted-foreground">
          Filters applied server-side: spam score ≤ 30 AND DataForSEO rank ≥
          10.
        </p>
      </div>
    </section>
  )
}

function PhaseStatus({ phase }: { phase: Phase }) {
  if (phase.status === "fetching-backlinks") {
    return (
      <p className="text-sm text-muted-foreground" aria-live="polite">
        Fetching referring domains from DataForSEO…
      </p>
    )
  }
  if (phase.status === "categorizing") {
    return (
      <p className="text-sm text-muted-foreground" aria-live="polite">
        Asking Claude to categorize {phase.count} prospects…
      </p>
    )
  }
  if (phase.status === "error") {
    return (
      <p
        className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
        role="alert"
      >
        {phase.message}
      </p>
    )
  }
  return null
}

function ResultsSection({
  partner,
  prospects,
  filtered,
  priorityFilter,
  categoryFilter,
  onPriorityChange,
  onCategoryChange,
  stats,
}: {
  partner: Partner
  prospects: CategorizedProspect[]
  filtered: CategorizedProspect[]
  priorityFilter: PriorityFilter
  categoryFilter: CategoryFilter
  onPriorityChange: (v: PriorityFilter) => void
  onCategoryChange: (v: CategoryFilter) => void
  stats: ResearchStats
}) {
  const [drafting, setDrafting] = useState<CategorizedProspect | null>(null)

  return (
    <section className="space-y-3">
      <div className="rounded-lg border bg-card p-4 text-xs text-muted-foreground">
        {stats.competitors} competitor{stats.competitors === 1 ? "" : "s"} •{" "}
        {stats.totalFetched.toLocaleString()} referring domains fetched •{" "}
        {stats.deduped.toLocaleString()} unique • {stats.afterFilter.toLocaleString()}{" "}
        passed spam / rank filter • {stats.scored.toLocaleString()} categorized
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">
            Priority
          </span>
          <Select
            value={priorityFilter}
            onValueChange={(v) => onPriorityChange(v as PriorityFilter)}
          >
            <SelectTrigger className="w-[160px]" aria-label="Filter by priority">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All priorities</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="low">Low</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">
            Category
          </span>
          <Select
            value={categoryFilter}
            onValueChange={(v) => onCategoryChange(v as CategoryFilter)}
          >
            <SelectTrigger className="w-[200px]" aria-label="Filter by category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All categories</SelectItem>
              <SelectItem value="citation">Citation</SelectItem>
              <SelectItem value="resource_page">Resource page</SelectItem>
              <SelectItem value="editorial">Editorial</SelectItem>
              <SelectItem value="supplier">Supplier</SelectItem>
              <SelectItem value="other">Other</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="ml-auto flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            {filtered.length} of {prospects.length} prospects
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => downloadCsv(prospects, partner.name)}
            disabled={prospects.length === 0}
          >
            <DownloadIcon className="mr-2 size-4" />
            Export CSV
          </Button>
        </div>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Domain</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Angle</TableHead>
              <TableHead>Priority</TableHead>
              <TableHead className="text-right">Rank</TableHead>
              <TableHead>Linking to</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="text-center text-sm text-muted-foreground"
                >
                  No prospects match the current filters.
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((p) => (
                <ProspectRow
                  key={p.domain}
                  prospect={p}
                  onDraft={() => setDrafting(p)}
                />
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <OutreachDialog
        partner={partner}
        prospect={drafting}
        onClose={() => setDrafting(null)}
      />
    </section>
  )
}

function ProspectRow({
  prospect,
  onDraft,
}: {
  prospect: CategorizedProspect
  onDraft: () => void
}) {
  const competitorHref = hrefFromDomain(prospect.referringTo)
  return (
    <TableRow>
      <TableCell className="font-medium">
        <a
          href={hrefFromDomain(prospect.domain)}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 hover:underline"
        >
          <span className="font-mono text-xs">{prospect.domain}</span>
          <ExternalLinkIcon className="size-3 text-muted-foreground" />
        </a>
      </TableCell>
      <TableCell>
        <CategoryBadge category={prospect.category} />
      </TableCell>
      <TableCell
        className="max-w-[420px] truncate text-xs text-muted-foreground"
        title={`${prospect.angle} — ${prospect.reasoning}`}
      >
        {prospect.angle}
      </TableCell>
      <TableCell>
        <PriorityBadge priority={prospect.outreachPriority} />
      </TableCell>
      <TableCell className="text-right tabular-nums text-xs">
        {prospect.rank}
      </TableCell>
      <TableCell className="text-xs">
        <a
          href={competitorHref}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 font-mono text-muted-foreground hover:text-foreground hover:underline"
        >
          {prospect.referringTo}
          <ExternalLinkIcon className="size-3" />
        </a>
      </TableCell>
      <TableCell className="text-right">
        <Button
          variant="outline"
          size="sm"
          onClick={onDraft}
          disabled={prospect.outreachPriority === "low"}
          title={
            prospect.outreachPriority === "low"
              ? "Skipping low-priority prospects by default. Raise priority to draft outreach."
              : "Draft a 3-email outreach sequence"
          }
        >
          <MailIcon className="mr-1 size-3" />
          Draft
        </Button>
      </TableCell>
    </TableRow>
  )
}

function hrefFromDomain(domain: string): string {
  if (/^https?:\/\//i.test(domain)) return domain
  return `https://${domain.replace(/\/+$/, "")}`
}

function CategoryBadge({ category }: { category: ProspectCategory }) {
  const label = CATEGORY_LABELS[category]
  if (category === "other") {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        {label}
      </Badge>
    )
  }
  return <Badge variant="secondary">{label}</Badge>
}

function PriorityBadge({ priority }: { priority: OutreachPriority }) {
  if (priority === "high") {
    return (
      <Badge
        variant="default"
        className="bg-emerald-600 text-white hover:bg-emerald-600/90"
      >
        High
      </Badge>
    )
  }
  if (priority === "medium") {
    return <Badge variant="secondary">Medium</Badge>
  }
  return (
    <Badge variant="outline" className="text-muted-foreground">
      Low
    </Badge>
  )
}

type DraftState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; emails: OutreachEmail[] }
  | { status: "error"; message: string }

function OutreachDialog({
  partner,
  prospect,
  onClose,
}: {
  partner: Partner
  prospect: CategorizedProspect | null
  onClose: () => void
}) {
  const [draft, setDraft] = useState<DraftState>({ status: "idle" })

  useEffect(() => {
    if (!prospect) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDraft({ status: "idle" })
      return
    }
    let cancelled = false
    const abort = new AbortController()
    setDraft({ status: "loading" })

    async function run() {
      try {
        const response = await fetch("/api/claude/outreach", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ partner, prospect }),
          signal: abort.signal,
        })
        const body = (await response.json().catch(() => ({}))) as {
          emails?: OutreachEmail[]
          error?: string
        }
        if (!response.ok || !body.emails) {
          throw new Error(
            body.error ?? `Outreach request failed (${response.status})`,
          )
        }
        if (!cancelled) setDraft({ status: "ready", emails: body.emails })
      } catch (err) {
        if (cancelled || (err instanceof Error && err.name === "AbortError")) {
          return
        }
        setDraft({
          status: "error",
          message:
            err instanceof Error ? err.message : "Failed to draft outreach",
        })
      }
    }
    run()
    return () => {
      cancelled = true
      abort.abort()
    }
  }, [partner, prospect])

  return (
    <Dialog
      open={prospect !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Outreach sequence{prospect ? ` for ${prospect.domain}` : ""}
          </DialogTitle>
          <DialogDescription>
            {prospect ? (
              <>
                3-email sequence for a{" "}
                <span className="font-medium">{CATEGORY_LABELS[prospect.category]}</span>{" "}
                prospect. Copy each email individually. Personalize the specifics
                before sending.
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        {draft.status === "loading" ? (
          <p className="text-sm text-muted-foreground">Drafting sequence…</p>
        ) : null}
        {draft.status === "error" ? (
          <p
            className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
            role="alert"
          >
            {draft.message}
          </p>
        ) : null}
        {draft.status === "ready" ? (
          <div className="max-h-[70vh] space-y-4 overflow-y-auto">
            {draft.emails.map((email, i) => (
              <EmailCard key={i} index={i} email={email} />
            ))}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function EmailCard({ index, email }: { index: number; email: OutreachEmail }) {
  const [copied, setCopied] = useState<"subject" | "body" | "full" | null>(null)

  const copy = useCallback(async (key: "subject" | "body" | "full", text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(key)
      window.setTimeout(() => setCopied(null), 1800)
    } catch (err) {
      console.error("[backlinks] clipboard write failed:", err)
    }
  }, [])

  const label =
    index === 0 ? "Initial email" : index === 1 ? "Follow-up #1" : "Follow-up #2"
  const full = `Subject: ${email.subject}\n\n${email.body}`

  return (
    <section className="rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{label}</span>
          <Badge variant="outline" className="text-[10px]">
            send after {email.sendAfterDays} day
            {email.sendAfterDays === 1 ? "" : "s"}
          </Badge>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => copy("full", full)}
          className="h-7"
        >
          {copied === "full" ? (
            <CheckIcon className="mr-1 size-3" />
          ) : (
            <CopyIcon className="mr-1 size-3" />
          )}
          {copied === "full" ? "Copied" : "Copy email"}
        </Button>
      </div>

      <div className="mt-3 space-y-2">
        <FieldRow
          label="Subject"
          value={email.subject}
          copied={copied === "subject"}
          onCopy={() => copy("subject", email.subject)}
        />
        <FieldRow
          label="Body"
          value={email.body}
          multiline
          copied={copied === "body"}
          onCopy={() => copy("body", email.body)}
        />
      </div>
    </section>
  )
}

function FieldRow({
  label,
  value,
  multiline,
  copied,
  onCopy,
}: {
  label: string
  value: string
  multiline?: boolean
  copied: boolean
  onCopy: () => void
}) {
  return (
    <div className="flex items-start gap-2">
      <div className="w-16 shrink-0 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "flex-1 rounded-md border bg-muted/40 px-3 py-2 text-sm",
          multiline ? "whitespace-pre-wrap" : "",
        )}
      >
        {value}
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={onCopy}
        className="h-7 shrink-0"
        aria-label={`Copy ${label.toLowerCase()}`}
      >
        {copied ? (
          <CheckIcon className="size-3" />
        ) : (
          <CopyIcon className="size-3" />
        )}
      </Button>
    </div>
  )
}
