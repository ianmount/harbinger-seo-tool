"use client"

import { Suspense, type ReactNode } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { PartnerSelector } from "@/components/PartnerSelector"
import { TabNav } from "@/components/TabNav"

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
    <div className="flex min-h-screen flex-col">
      <header className="border-b bg-background">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <Link href="/" className="text-base font-semibold tracking-tight">
            Harbinger SEO Tool
          </Link>
          <Suspense fallback={null}>
            <PartnerSelector />
          </Suspense>
        </div>
      </header>
      <Suspense fallback={<div className="h-12 border-b" aria-hidden />}>
        <TabNav />
      </Suspense>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        <Suspense fallback={null}>{children}</Suspense>
      </main>
    </div>
  )
}
