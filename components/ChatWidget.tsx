"use client"

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react"
import { usePathname, useSearchParams } from "next/navigation"
import { Loader2, MessageSquare, Send, Trash2, X } from "lucide-react"
import ReactMarkdown from "react-markdown"
import { useAssessment } from "@/lib/assessment-context"
import { useChat, type ChatPageContext } from "@/lib/chat-context"
import { useSelectedPartner } from "@/lib/use-selected-partner"
import { cn } from "@/lib/utils"

const TAB_LABELS: Record<string, string> = {
  "/audit": "Audit",
  "/comp-analysis": "Comp Analysis",
  "/strategy": "Strategy",
  "/content": "Content",
  "/backlinks": "Backlinks",
  "/reporting": "Reporting",
  "/keyword-research": "Keyword Research",
  "/onboarding": "Onboarding",
  "/": "Home",
}

function tabLabelFor(pathname: string): string {
  if (TAB_LABELS[pathname]) return TAB_LABELS[pathname]
  for (const [prefix, label] of Object.entries(TAB_LABELS)) {
    if (prefix !== "/" && pathname.startsWith(prefix)) return label
  }
  return "App"
}

/**
 * Pushes pathname + partner + assessment state into the chat as base
 * context. Lives inside ChatProvider so it has access to setBaseContext.
 * Rendered alongside the widget in AppShell.
 */
export function ChatBaseContextSync() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const partnerId = searchParams.get("partnerId")
  const { partner } = useSelectedPartner()
  const { state: assessment } = useAssessment()
  const { setBaseContext } = useChat()

  useEffect(() => {
    const tab = tabLabelFor(pathname)
    const summaryLines: string[] = []
    const data: Record<string, unknown> = {}

    if (partner) {
      summaryLines.push(
        `Selected partner: ${partner.name} (${partner.website || "no website"}).`,
      )
      data.partner = {
        id: partner.id,
        name: partner.name,
        website: partner.website,
        services: partner.services,
        serviceAreas: partner.serviceAreas,
      }
    } else if (partnerId) {
      summaryLines.push(`Partner ID in URL: ${partnerId} (still loading).`)
    }

    // Assessment workflow context — only attached when there's actual
    // input/output to talk about. Audit + Comp Analysis tabs share this.
    const onAssessmentTab =
      pathname === "/audit" || pathname === "/comp-analysis"
    const hasAssessmentInputs =
      assessment.websiteUrl ||
      assessment.targetLocations ||
      assessment.priorityServices
    if (onAssessmentTab && hasAssessmentInputs) {
      const summary: Record<string, unknown> = {}
      if (assessment.websiteUrl) summary.websiteUrl = assessment.websiteUrl
      if (assessment.priorityServices)
        summary.priorityServices = assessment.priorityServices
      if (assessment.negativeKeywords)
        summary.negativeKeywords = assessment.negativeKeywords
      if (assessment.idealCustomer)
        summary.idealCustomer = assessment.idealCustomer
      if (assessment.targetLocations)
        summary.targetLocations = assessment.targetLocations
      if (assessment.existingTargetKeywords)
        summary.existingTargetKeywords = assessment.existingTargetKeywords
      if (assessment.auditResult) {
        summary.auditCompleted = true
        summary.auditWebsite = assessment.auditResult.websiteUrl
        summary.auditWarnings = assessment.auditResult.warnings
        summary.auditDurationSeconds =
          assessment.auditResult.durationSeconds
        // Truncated audit markdown so Claude can answer specific
        // questions about findings without us having to re-run the audit.
        const md = assessment.auditResult.auditMarkdown
        summary.auditMarkdown =
          md.length > 6000 ? md.slice(0, 6000) + "\n…[truncated]" : md
      }
      if (assessment.compAnalysisRows) {
        summary.compAnalysisCompleted = true
        summary.compAnalysisLocationCount =
          assessment.compAnalysisRows.length
        summary.compAnalysisWarnings = assessment.compAnalysisWarnings
      }
      data.assessment = summary
    }

    const slice: ChatPageContext = {
      tab,
      pathname,
      summary: summaryLines.join(" ") || undefined,
      data: Object.keys(data).length > 0 ? data : undefined,
    }
    setBaseContext(slice)
  }, [pathname, partner, partnerId, assessment, setBaseContext])

  return null
}

/**
 * Floating chat widget — collapsed FAB in the bottom-right that expands
 * into a side panel. Visible on every tab; messages persist across
 * navigation but are wiped on refresh.
 */
export function ChatWidget() {
  const {
    messages,
    isOpen,
    isSending,
    error,
    open,
    close,
    sendMessage,
    clear,
  } = useChat()
  const [draft, setDraft] = useState("")
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (isOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
    }
  }, [messages, isOpen])

  useEffect(() => {
    if (isOpen) {
      textareaRef.current?.focus()
    }
  }, [isOpen])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!draft.trim() || isSending) return
    const text = draft
    setDraft("")
    await sendMessage(text)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      void handleSubmit(e as unknown as FormEvent)
    }
  }

  return (
    <>
      {!isOpen && (
        <button
          type="button"
          onClick={open}
          aria-label="Open chat assistant"
          className="fixed bottom-5 right-5 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-brand-navy text-white shadow-[0_8px_24px_-8px_rgba(3,41,58,0.5)] transition-transform hover:scale-105 hover:bg-brand-navy-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2"
        >
          <MessageSquare className="h-5 w-5" />
        </button>
      )}

      {isOpen && (
        <div
          role="dialog"
          aria-label="Chat assistant"
          className="fixed bottom-5 right-5 z-40 flex h-[600px] max-h-[calc(100vh-2.5rem)] w-[400px] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-lg border border-border bg-background shadow-[0_24px_60px_-24px_rgba(3,41,58,0.45)]"
        >
          <header className="flex items-center justify-between border-b border-border bg-brand-navy px-4 py-3 text-white">
            <div className="flex items-center gap-2">
              <MessageSquare className="h-4 w-4" />
              <span className="font-sans text-[11px] font-extrabold uppercase tracking-[0.18em]">
                Assistant
              </span>
            </div>
            <div className="flex items-center gap-1">
              {messages.length > 0 && (
                <button
                  type="button"
                  onClick={clear}
                  aria-label="Clear conversation"
                  className="rounded p-1.5 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
              <button
                type="button"
                onClick={close}
                aria-label="Close chat"
                className="rounded p-1.5 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </header>

          <div className="flex-1 overflow-y-auto bg-brand-paper px-4 py-4">
            {messages.length === 0 && !isSending && (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                <p className="font-serif text-[14px] italic text-ink-2">
                  Ask me anything about what you&apos;re working on.
                </p>
                <p className="max-w-[280px] font-sans text-[12px] text-ink-3">
                  I can see the tab you&apos;re on, the partner you have
                  selected, and any data already loaded. Examples: &ldquo;explain
                  finding #3&rdquo;, &ldquo;what should I prioritize in this
                  cluster&rdquo;, &ldquo;draft outreach for this
                  domain&rdquo;.
                </p>
              </div>
            )}

            <div className="flex flex-col gap-3">
              {messages.map((msg) => (
                <ChatBubble key={msg.id} role={msg.role} content={msg.content} />
              ))}
              {isSending && (
                <div className="flex items-center gap-2 text-ink-3">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span className="font-sans text-[12px]">Thinking…</span>
                </div>
              )}
            </div>
            <div ref={messagesEndRef} />
          </div>

          {error && (
            <div className="border-t border-destructive/40 bg-destructive/5 px-4 py-2 text-[12px] text-destructive">
              {error}
            </div>
          )}

          <form
            onSubmit={handleSubmit}
            className="flex items-end gap-2 border-t border-border bg-background px-3 py-3"
          >
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about this tab…"
              rows={2}
              disabled={isSending}
              className={cn(
                "min-h-[40px] flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 font-sans text-[13px] text-foreground placeholder:text-ink-3",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "disabled:cursor-not-allowed disabled:opacity-60",
              )}
            />
            <button
              type="submit"
              disabled={isSending || !draft.trim()}
              aria-label="Send message"
              className={cn(
                "flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-brand-navy text-white transition-colors hover:bg-brand-navy-700",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              <Send className="h-4 w-4" />
            </button>
          </form>
        </div>
      )}
    </>
  )
}

function ChatBubble({
  role,
  content,
}: {
  role: "user" | "assistant"
  content: string
}) {
  if (role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-lg rounded-br-sm bg-brand-navy px-3 py-2 font-sans text-[13px] leading-relaxed text-white">
          {content}
        </div>
      </div>
    )
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] rounded-lg rounded-bl-sm border border-border bg-background px-3 py-2 font-sans text-[13px] leading-relaxed text-foreground">
        <div className="prose prose-sm max-w-none [&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_ul]:my-1.5 [&_ol]:my-1.5 [&_li]:my-0.5 [&_code]:rounded [&_code]:bg-brand-sand/40 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[12px] [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-brand-sand/40 [&_pre]:p-2 [&_pre]:text-[12px]">
          <ReactMarkdown>{content}</ReactMarkdown>
        </div>
      </div>
    </div>
  )
}
