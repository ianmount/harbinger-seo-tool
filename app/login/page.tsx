"use client"

import { useState, type FormEvent } from "react"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
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
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Harbinger SEO Tool</CardTitle>
          <CardDescription>Enter the app password to continue.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                autoFocus
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
              />
            </div>
            {error ? (
              <p
                role="alert"
                className="text-sm text-destructive"
                aria-live="polite"
              >
                {error}
              </p>
            ) : null}
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
