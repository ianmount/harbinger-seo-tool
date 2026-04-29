"use client"

import { Suspense, type ReactNode } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { ChatBaseContextSync, ChatWidget } from "@/components/ChatWidget"
import { PartnerSelector } from "@/components/PartnerSelector"
import { SideNav } from "@/components/SideNav"
import { AssessmentProvider } from "@/lib/assessment-context"
import { ChatProvider } from "@/lib/chat-context"

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
 * Wraps page children with the app chrome (sidebar nav, top bar, main).
 * Renders children only on `/login` so the unauthenticated login page
 * isn't cluttered with nav that can't be used.
 *
 * Suspense wrappers around PartnerSelector / SideNav are required by
 * Next.js for any client component that calls useSearchParams.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname()

  if (pathname === "/login") {
    return <>{children}</>
  }

  return (
    <AssessmentProvider>
      <ChatProvider>
        <Suspense fallback={null}>
          <ChatBaseContextSync />
        </Suspense>
        <div className="flex min-h-screen">
          <aside className="sticky top-0 z-30 flex h-screen w-60 shrink-0 flex-col bg-[color:var(--sidebar)] text-[color:var(--sidebar-foreground)]">
            <Link
              href="/"
              className="flex items-center gap-3 border-b border-[color:var(--sidebar-border)] px-5 py-5"
            >
              <span className="block h-9 w-9 shrink-0 overflow-hidden rounded-[6px] shadow-[0_4px_12px_-6px_rgba(0,0,0,0.6)]">
                <HMark className="block h-full w-full" />
              </span>
              <span className="flex flex-col leading-none">
                <span className="font-sans text-[9.5px] font-extrabold uppercase tracking-[0.22em] text-[color:var(--sidebar-foreground)]/70">
                  Harbinger
                </span>
                <span className="mt-1 font-sans text-[15px] font-extrabold tracking-[-0.005em] text-brand-cream">
                  SEO Tool
                </span>
              </span>
            </Link>
            <Suspense
              fallback={<div className="flex-1" aria-hidden />}
            >
              <SideNav />
            </Suspense>
          </aside>
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="sticky top-0 z-20 border-b border-border bg-background/85 backdrop-blur">
              <div className="mx-auto flex max-w-6xl items-center justify-end gap-4 px-4 py-3 sm:px-6">
                <Suspense fallback={null}>
                  <PartnerSelector />
                </Suspense>
              </div>
            </header>
            <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-6">
              <Suspense fallback={null}>{children}</Suspense>
            </main>
          </div>
        </div>
        <ChatWidget />
      </ChatProvider>
    </AssessmentProvider>
  )
}
