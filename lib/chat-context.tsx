"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"

/**
 * Floating-chat infrastructure. The chat widget lives in AppShell and is
 * available on every tab. Each tab can register additional structured
 * context via `useChatPageContext`, which is merged with the auto-pulled
 * pathname/partner/assessment context when a message is sent.
 *
 * State is in-memory only — refreshing the page wipes the conversation
 * and the page context, matching the rest of the app.
 */

export interface ChatMessage {
  id: string
  role: "user" | "assistant"
  content: string
}

export interface ChatPageContext {
  /** Short label for the tab/area (e.g. "Audit", "Strategy"). */
  tab?: string
  pathname?: string
  /** Free-form text describing the user's current situation. */
  summary?: string
  /** Structured data — gets serialized as JSON into the system prompt. */
  data?: Record<string, unknown>
}

interface ChatContextValue {
  messages: ChatMessage[]
  isOpen: boolean
  isSending: boolean
  error: string | null
  open: () => void
  close: () => void
  toggle: () => void
  sendMessage: (text: string) => Promise<void>
  clear: () => void
  /** Merged context that the next request will use. */
  pageContext: ChatPageContext
  /** Internal: registers a per-tab context slice. */
  registerContextSlice: (id: string, slice: ChatPageContext | null) => void
  /** Internal: auto-pulled context (pathname/partner/assessment). */
  setBaseContext: (slice: ChatPageContext) => void
}

const ChatContext = createContext<ChatContextValue | null>(null)

function genId(): string {
  return Math.random().toString(36).slice(2, 10)
}

function mergeContexts(
  base: ChatPageContext,
  slices: Map<string, ChatPageContext>,
): ChatPageContext {
  const merged: ChatPageContext = { ...base }
  const summaryParts: string[] = []
  if (base.summary) summaryParts.push(base.summary)
  const data: Record<string, unknown> = { ...(base.data ?? {}) }
  for (const slice of slices.values()) {
    if (slice.tab) merged.tab = slice.tab
    if (slice.pathname) merged.pathname = slice.pathname
    if (slice.summary) summaryParts.push(slice.summary)
    if (slice.data) Object.assign(data, slice.data)
  }
  if (summaryParts.length > 0) merged.summary = summaryParts.join("\n\n")
  if (Object.keys(data).length > 0) merged.data = data
  return merged
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isOpen, setIsOpen] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [baseContext, setBaseContextState] = useState<ChatPageContext>({})
  const [slices, setSlices] = useState<Map<string, ChatPageContext>>(
    () => new Map(),
  )

  const setBaseContext = useCallback((slice: ChatPageContext) => {
    setBaseContextState(slice)
  }, [])

  const registerContextSlice = useCallback(
    (id: string, slice: ChatPageContext | null) => {
      setSlices((prev) => {
        const next = new Map(prev)
        if (slice == null) {
          if (!next.has(id)) return prev
          next.delete(id)
        } else {
          next.set(id, slice)
        }
        return next
      })
    },
    [],
  )

  const pageContext = useMemo(
    () => mergeContexts(baseContext, slices),
    [baseContext, slices],
  )

  const open = useCallback(() => setIsOpen(true), [])
  const close = useCallback(() => setIsOpen(false), [])
  const toggle = useCallback(() => setIsOpen((v) => !v), [])
  const clear = useCallback(() => {
    setMessages([])
    setError(null)
  }, [])

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed || isSending) return
      setError(null)
      const userMsg: ChatMessage = {
        id: genId(),
        role: "user",
        content: trimmed,
      }
      // Snapshot history at send time so the request body matches what
      // the user sees in the UI.
      const history = [...messages, userMsg]
      setMessages(history)
      setIsSending(true)
      try {
        const res = await fetch("/api/claude/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: history.map(({ role, content }) => ({ role, content })),
            pageContext,
          }),
        })
        const body = (await res.json().catch(() => ({}))) as {
          reply?: string
          error?: string
        }
        if (!res.ok || !body.reply) {
          throw new Error(body.error ?? `HTTP ${res.status}`)
        }
        setMessages((prev) => [
          ...prev,
          { id: genId(), role: "assistant", content: body.reply! },
        ])
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Failed to send"
        setError(message)
      } finally {
        setIsSending(false)
      }
    },
    [messages, isSending, pageContext],
  )

  const value = useMemo<ChatContextValue>(
    () => ({
      messages,
      isOpen,
      isSending,
      error,
      open,
      close,
      toggle,
      sendMessage,
      clear,
      pageContext,
      registerContextSlice,
      setBaseContext,
    }),
    [
      messages,
      isOpen,
      isSending,
      error,
      open,
      close,
      toggle,
      sendMessage,
      clear,
      pageContext,
      registerContextSlice,
      setBaseContext,
    ],
  )

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>
}

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatContext)
  if (!ctx) {
    throw new Error("useChat must be used within a ChatProvider")
  }
  return ctx
}

/**
 * Tabs call this to register their page-specific context with the chat.
 * The slice is merged into the system prompt every time the user sends
 * a message. Pass `null` (or unmount the component) to deregister.
 *
 * Example:
 *
 *   useChatPageContext("audit-form", {
 *     tab: "Audit",
 *     summary: `Auditing ${websiteUrl}, target locations: ${locations}`,
 *     data: { websiteUrl, locations, hasResult: !!auditResult },
 *   })
 */
export function useChatPageContext(
  id: string,
  slice: ChatPageContext | null,
) {
  const { registerContextSlice } = useChat()
  // Stable serialization so we only re-register when the content changes.
  const serialized = slice == null ? null : JSON.stringify(slice)
  useEffect(() => {
    if (serialized == null) {
      registerContextSlice(id, null)
      return
    }
    registerContextSlice(id, JSON.parse(serialized) as ChatPageContext)
    return () => registerContextSlice(id, null)
  }, [id, serialized, registerContextSlice])
}
