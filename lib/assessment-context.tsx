"use client"

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import type {
  AssessmentAuditResult,
  CompAnalysisLocationRows,
} from "@/lib/types"

/**
 * Shared in-memory state for the Assessment workflow (Audit + Competitive
 * Analysis tabs). Refreshing the page wipes the state — that's the
 * intended behavior at this stage. No database, no localStorage.
 *
 * The Audit tab populates websiteUrl, targetLocations, gscData, and
 * existingTargetKeywords; the Comp Analysis tab reads those fields back to
 * pre-fill its own form. If the user navigates straight to Comp Analysis
 * without running the Audit, the fields are simply empty.
 */

export interface AssessmentState {
  // Manual inputs (Audit tab form).
  websiteUrl: string
  priorityServices: string
  negativeKeywords: string
  /** Newline-separated. */
  existingTargetKeywords: string
  idealCustomer: string
  /** Newline-separated, "City, ST" format. */
  targetLocations: string

  // Audit tab outputs.
  auditResult: AssessmentAuditResult | null

  // Comp Analysis tab inputs/outputs.
  competitorUrls: string[]
  compAnalysisRows: CompAnalysisLocationRows[] | null
  compAnalysisCsv: string | null
  compAnalysisRunAt: string | null
  compAnalysisWarnings: string[]
}

const INITIAL_STATE: AssessmentState = {
  websiteUrl: "",
  priorityServices: "",
  negativeKeywords: "",
  existingTargetKeywords: "",
  idealCustomer: "",
  targetLocations: "",
  auditResult: null,
  competitorUrls: [],
  compAnalysisRows: null,
  compAnalysisCsv: null,
  compAnalysisRunAt: null,
  compAnalysisWarnings: [],
}

interface AssessmentContextValue {
  state: AssessmentState
  setField: <K extends keyof AssessmentState>(
    key: K,
    value: AssessmentState[K],
  ) => void
  setMany: (patch: Partial<AssessmentState>) => void
  reset: () => void
}

const AssessmentContext = createContext<AssessmentContextValue | null>(null)

export function AssessmentProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AssessmentState>(INITIAL_STATE)

  const setField = useCallback(
    <K extends keyof AssessmentState>(key: K, value: AssessmentState[K]) => {
      setState((prev) => ({ ...prev, [key]: value }))
    },
    [],
  )

  const setMany = useCallback((patch: Partial<AssessmentState>) => {
    setState((prev) => ({ ...prev, ...patch }))
  }, [])

  const reset = useCallback(() => {
    setState(INITIAL_STATE)
  }, [])

  const value = useMemo<AssessmentContextValue>(
    () => ({ state, setField, setMany, reset }),
    [state, setField, setMany, reset],
  )

  return (
    <AssessmentContext.Provider value={value}>
      {children}
    </AssessmentContext.Provider>
  )
}

export function useAssessment(): AssessmentContextValue {
  const ctx = useContext(AssessmentContext)
  if (!ctx) {
    throw new Error(
      "useAssessment must be used within an AssessmentProvider (wrap with <AssessmentProvider> in the app shell).",
    )
  }
  return ctx
}
