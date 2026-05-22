"use client"

import { useEffect, useState } from "react"
import { CheckIcon, FolderPlusIcon, Loader2Icon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { Partner, PartnerArtifactKind } from "@/lib/types"

interface SaveToPartnerButtonProps {
  kind: PartnerArtifactKind
  /** Default title shown in the dialog input. */
  defaultTitle: string
  /** Lazy payload getter; called only when the user clicks Save. */
  getData: () => unknown | Promise<unknown>
  /** Currently selected partner id from the URL (?partnerId=…). */
  partnerId?: string | null
  /** Optional pre-fetched partner record so we don't need to look it up. */
  partner?: Partner | null
  /** Visual variant of the wrapping Button. */
  variant?: "default" | "outline" | "secondary" | "ghost"
  /** Optional className passthrough. */
  className?: string
  /** Optional callback once the artifact is saved (e.g. to disable the button). */
  onSaved?: (artifactId: string) => void
}

/**
 * Drop-in button for tool output cards. Pops a dialog to confirm title,
 * lets the user pick a partner if none is selected on the page, and
 * POSTs the payload to /api/partners/:id/artifacts.
 *
 * If a `?partnerId=…` is already in the URL or `partner` is passed,
 * skips the partner picker.
 */
export function SaveToPartnerButton({
  kind,
  defaultTitle,
  getData,
  partnerId,
  partner: partnerProp,
  variant = "outline",
  className,
  onSaved,
}: SaveToPartnerButtonProps) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState(defaultTitle)
  const [selectedId, setSelectedId] = useState<string>(partnerId ?? "")
  const [partners, setPartners] = useState<Partner[]>([])
  const [partnersLoading, setPartnersLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!open) return
    if (partnerProp || selectedId) return
    setPartnersLoading(true)
    const ac = new AbortController()
    fetch("/api/partners", { signal: ac.signal })
      .then((r) => r.json())
      .then((body: { partners?: Partner[] }) => {
        setPartners(
          (body.partners ?? [])
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name)),
        )
      })
      .catch(() => undefined)
      .finally(() => setPartnersLoading(false))
    return () => ac.abort()
  }, [open, partnerProp, selectedId])

  useEffect(() => {
    if (open) {
      setTitle(defaultTitle)
      setSaved(false)
    }
  }, [open, defaultTitle])

  const targetId = partnerProp?.id ?? selectedId

  async function handleSave() {
    if (!targetId || !title.trim()) return
    setSaving(true)
    try {
      const data = await getData()
      const res = await fetch(
        `/api/partners/${encodeURIComponent(targetId)}/artifacts`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, title: title.trim(), data }),
        },
      )
      const body = (await res.json()) as {
        artifact?: { id: string }
        error?: string
      }
      if (!res.ok || !body.artifact) {
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      toast.success("Saved to partner folder")
      setSaved(true)
      onSaved?.(body.artifact.id)
      setOpen(false)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Button
        variant={variant}
        size="sm"
        onClick={() => setOpen(true)}
        className={className}
      >
        {saved ? (
          <CheckIcon className="mr-1.5 size-4" />
        ) : (
          <FolderPlusIcon className="mr-1.5 size-4" />
        )}
        {saved ? "Saved" : "Save to partner"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save to partner folder</DialogTitle>
            <DialogDescription>
              Save this output to a partner&rsquo;s workspace. It will show up
              in their Artifacts tab.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {!partnerProp && (
              <div className="space-y-2">
                <Label htmlFor="save-partner">Partner</Label>
                <Select value={selectedId} onValueChange={setSelectedId}>
                  <SelectTrigger id="save-partner" className="w-full">
                    <SelectValue
                      placeholder={
                        partnersLoading ? "Loading partners…" : "Select a partner"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {partners.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {partnerProp && (
              <p className="text-sm text-muted-foreground">
                Saving to <span className="font-medium">{partnerProp.name}</span>
              </p>
            )}

            <div className="space-y-2">
              <Label htmlFor="save-title">Title</Label>
              <Input
                id="save-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Give this artifact a name"
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving || !targetId || !title.trim()}
            >
              {saving ? (
                <>
                  <Loader2Icon className="mr-1.5 size-4 animate-spin" />
                  Saving…
                </>
              ) : (
                "Save"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
