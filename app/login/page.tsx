"use client"

import { useState, type FormEvent } from "react"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

function safeNextPath(): string {
  if (typeof window === "undefined") return "/"
  const raw = new URLSearchParams(window.location.search).get("next")
  if (!raw) return "/"
  // Allow same-origin relative paths only; reject protocol-relative and absolute URLs.
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/"
  return raw
}

/**
 * Harbinger double-H mark, per design/DESIGN_NOTES.md § Brand identity.
 * Navy field, diagonal red from top-right, white glyph. Scales via CSS.
 */
function HMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 100 100"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className={className}
    >
      <rect width="100" height="100" fill="#03293A" />
      <polygon points="0,0 100,100 0,100" fill="#FF1E00" />
      <g fill="#FFFFFF">
        <rect x="22" y="18" width="22" height="6" />
        <rect x="22" y="76" width="22" height="6" />
        <rect x="28" y="24" width="10" height="52" />
        <rect x="56" y="18" width="22" height="6" />
        <rect x="56" y="76" width="22" height="6" />
        <rect x="62" y="24" width="10" height="52" />
        <rect x="28" y="47" width="44" height="6" />
      </g>
    </svg>
  )
}

export default function LoginPage() {
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      })
      if (response.ok) {
        window.location.href = safeNextPath()
        return
      }
      if (response.status === 429) {
        setError("Too many failed attempts. Try again in a few minutes.")
      } else if (response.status === 401) {
        setError("Incorrect password.")
      } else if (response.status === 503) {
        setError(
          "Auth is not configured on the server. Set APP_PASSWORD and APP_AUTH_SECRET in Vercel.",
        )
      } else {
        const body = (await response.json().catch(() => ({}))) as {
          error?: string
        }
        setError(body.error ?? `Login failed (status ${response.status}).`)
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Network error")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="flex min-h-[calc(100vh-2rem)] items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <Card className="shadow-elev">
          <CardHeader className="flex-row items-center gap-4">
            <div className="h-14 w-14 shrink-0 overflow-hidden rounded-[10px] shadow-[0_6px_18px_-6px_rgba(3,41,58,0.3)]">
              <HMark className="block h-full w-full" />
            </div>
            <div className="min-w-0">
              <p className="eyebrow eyebrow-red">Harbinger · Internal</p>
              <h1 className="mt-1 font-sans text-[22px] font-extrabold leading-[1.1] tracking-[-0.005em]">
                SEO Tool
              </h1>
              <p className="mt-1 font-serif text-[13.5px] italic leading-snug text-ink-2">
                Sign in to continue to the <b className="font-sans not-italic font-extrabold text-ink-1">partner workspace</b>.
              </p>
            </div>
          </CardHeader>

          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="space-y-2">
                <Label
                  htmlFor="password"
                  className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-2"
                >
                  Password
                </Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  autoFocus
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={submitting}
                  className="font-serif text-[14px]"
                />
              </div>

              {error ? (
                <p
                  role="alert"
                  className="border-l-[3px] border-destructive bg-destructive/5 px-3 py-2 font-serif text-[13.5px] italic leading-snug text-destructive"
                  aria-live="polite"
                >
                  {error}
                </p>
              ) : null}

              <Button
                type="submit"
                className="w-full font-sans text-[12.5px] font-bold uppercase tracking-[0.08em]"
                disabled={submitting}
                size="lg"
              >
                {submitting ? "Signing in…" : "Sign in"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <footer className="mt-6 flex items-center gap-3 border-t border-dashed border-line-strong pt-4">
          <span className="relative h-5 w-5 shrink-0 overflow-hidden rounded-[4px] bg-brand-navy">
            <span
              aria-hidden
              className="absolute inset-0 bg-brand-red"
              style={{ clipPath: "polygon(0 0, 100% 100%, 0 100%)" }}
            />
          </span>
          <span className="font-sans text-[10.5px] font-medium uppercase tracking-[0.18em] text-ink-3">
            Harbinger Marketing · Internal Tool
          </span>
        </footer>
      </div>
    </main>
  )
}
