"use client"

import { Suspense, type ReactNode } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { PartnerSelector } from "@/components/PartnerSelector"
import { TabNav } from "@/components/TabNav"
import { AssessmentProvider } from "@/lib/assessment-context"

/**
 * Harbinger H-mark. Navy field, diagonal red from top-right, white
 * double-H glyph. Kept inline so the shell never shows a missing-asset
 * placeholder during Suspense.
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

/**
 * Wraps page children with the app chrome (header, partner selector, tab
 * nav). Renders children only on `/login` so the unauthenticated login
 * page isn't cluttered with nav that can't be used.
 *
 * Suspense wrappers around PartnerSelector / TabNav are required by
 * Next.js for any client component that calls useSearchParams.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname()

  if (pathname === "/login") {
    return <>{children}</>
  }

  return (
    <AssessmentProvider>
      <div className="flex min-h-screen flex-col">
        <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
            <Link href="/" className="flex items-center gap-3">
              <span className="block h-8 w-8 shrink-0 overflow-hidden rounded-[6px] shadow-[0_4px_12px_-6px_rgba(3,41,58,0.4)]">
                <HMark className="block h-full w-full" />
              </span>
              <span className="flex flex-col leading-none">
                <span className="font-sans text-[9.5px] font-extrabold uppercase tracking-[0.22em] text-ink-3">
                  Harbinger
                </span>
                <span className="mt-1 font-sans text-[15px] font-extrabold tracking-[-0.005em] text-foreground">
                  SEO Tool
                </span>
              </span>
            </Link>
            <Suspense fallback={null}>
              <PartnerSelector />
            </Suspense>
          </div>
        </header>
        <Suspense fallback={<div className="h-12 border-b border-border" aria-hidden />}>
          <TabNav />
        </Suspense>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-6">
          <Suspense fallback={null}>{children}</Suspense>
        </main>
      </div>
    </AssessmentProvider>
  )
}
