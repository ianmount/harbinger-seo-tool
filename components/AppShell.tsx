"use client"

import { Suspense, useEffect, useState, type ReactNode } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Menu, X } from "lucide-react"
import { ChatBaseContextSync, ChatWidget } from "@/components/ChatWidget"
import { JobsTray } from "@/components/JobsTray"
import { SideNav } from "@/components/SideNav"
import { Toaster } from "@/components/ui/sonner"
import { AssessmentProvider } from "@/lib/assessment-context"
import { ChatProvider } from "@/lib/chat-context"
import { cn } from "@/lib/utils"

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

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const [navOpen, setNavOpen] = useState(false)

  useEffect(() => {
    setNavOpen(false)
  }, [pathname])

  if (pathname === "/login") {
    return <>{children}</>
  }

  const isHome = pathname === "/"

  return (
    <AssessmentProvider>
      <ChatProvider>
        <Suspense fallback={null}>
          <ChatBaseContextSync />
        </Suspense>
        <div className="flex min-h-screen">
          {!isHome && (
            <>
              {navOpen && (
                <button
                  type="button"
                  aria-label="Close navigation"
                  onClick={() => setNavOpen(false)}
                  className="fixed inset-0 z-30 bg-black/40 md:hidden"
                />
              )}
              {/* Sidebar — static flex child so background spans full doc height;
                  inner div is sticky so nav content stays visible while scrolling */}
              <aside
                className={cn(
                  "z-40 w-60 shrink-0 bg-[color:var(--sidebar)] text-[color:var(--sidebar-foreground)]",
                  "fixed inset-y-0 left-0 transition-transform duration-200 ease-out",
                  "md:static md:translate-x-0",
                  navOpen ? "translate-x-0 shadow-overlay" : "-translate-x-full",
                )}
              >
                <div className="flex h-full flex-col md:sticky md:top-0 md:h-screen">
                  <div className="flex items-center justify-between gap-3 border-b border-[color:var(--sidebar-border)] px-5 py-5">
                    <Link href="/" className="flex items-center gap-3">
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
                    <button
                      type="button"
                      onClick={() => setNavOpen(false)}
                      aria-label="Close navigation"
                      className="-mr-1 inline-flex h-8 w-8 items-center justify-center rounded text-[color:var(--sidebar-foreground)] hover:bg-[color:var(--sidebar-accent)]/40 hover:text-brand-cream md:hidden"
                    >
                      <X className="h-5 w-5" />
                    </button>
                  </div>
                  <Suspense fallback={<div className="flex-1" aria-hidden />}>
                    <SideNav />
                  </Suspense>
                </div>
              </aside>
            </>
          )}

          <div className="flex min-w-0 flex-1 flex-col">
            <header className="sticky top-0 z-20 border-b border-border bg-background/85 backdrop-blur">
              <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3 sm:px-6">
                {isHome ? (
                  <Link href="/" className="flex items-center gap-3">
                    <span className="block h-8 w-8 shrink-0 overflow-hidden rounded-[6px] shadow-[0_4px_12px_-6px_rgba(0,0,0,0.6)]">
                      <HMark className="block h-full w-full" />
                    </span>
                    <span className="flex flex-col leading-none">
                      <span className="font-sans text-[9px] font-extrabold uppercase tracking-[0.22em] text-foreground/50">
                        Harbinger
                      </span>
                      <span className="font-sans text-[13px] font-extrabold tracking-[-0.005em] text-foreground">
                        SEO Tool
                      </span>
                    </span>
                  </Link>
                ) : (
                  <button
                    type="button"
                    onClick={() => setNavOpen(true)}
                    aria-label="Open navigation"
                    aria-expanded={navOpen}
                    className="-ml-2 inline-flex h-9 w-9 items-center justify-center rounded text-foreground hover:bg-brand-sand/40 md:hidden"
                  >
                    <Menu className="h-5 w-5" />
                  </button>
                )}
                <div className="ml-auto flex items-center gap-2">
                  <JobsTray />
                </div>
              </div>
            </header>
            <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-6">
              <Suspense fallback={null}>{children}</Suspense>
            </main>
          </div>
        </div>
        <ChatWidget />
        <Toaster />
      </ChatProvider>
    </AssessmentProvider>
  )
}
