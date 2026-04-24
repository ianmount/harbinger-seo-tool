import "server-only"
import { AsyncLocalStorage } from "node:async_hooks"

/**
 * Per-audit cost tracker.
 *
 * Threads a mutable cost accumulator through the call stack via
 * AsyncLocalStorage so DataForSEO / Claude helpers can report into it
 * without adding a `ctx` parameter to every signature. If no store is
 * active (i.e. calls from outside an audit), record() is a no-op.
 *
 * Units are US dollars. DataForSEO returns `cost` on each envelope; Claude's
 * usage is converted from token counts using current Opus 4.7 pricing
 * ($15 / MTok input, $75 / MTok output). Pricing moves — update the
 * constants below when Anthropic publishes new rates.
 */

export interface CostAccumulator {
  dataforseoUsd: number
  claudeUsd: number
  dataforseoCalls: number
  claudeCalls: number
  claudeInputTokens: number
  claudeOutputTokens: number
}

export function createCostAccumulator(): CostAccumulator {
  return {
    dataforseoUsd: 0,
    claudeUsd: 0,
    dataforseoCalls: 0,
    claudeCalls: 0,
    claudeInputTokens: 0,
    claudeOutputTokens: 0,
  }
}

const storage = new AsyncLocalStorage<CostAccumulator>()

export function withAuditCost<T>(
  accumulator: CostAccumulator,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(accumulator, fn)
}

export function getActiveCost(): CostAccumulator | undefined {
  return storage.getStore()
}

export function recordDataForSEOCost(costUsd: number): void {
  const store = storage.getStore()
  if (!store) return
  store.dataforseoUsd += costUsd
  store.dataforseoCalls += 1
}

// Anthropic Opus 4.7 pricing (USD per million tokens) — verify before any
// commercial launch; safe default is to slightly over-estimate.
const OPUS_INPUT_USD_PER_MTOK = 15
const OPUS_OUTPUT_USD_PER_MTOK = 75

export function recordClaudeCost(opts: {
  inputTokens: number
  outputTokens: number
}): void {
  const store = storage.getStore()
  if (!store) return
  const inputUsd = (opts.inputTokens / 1_000_000) * OPUS_INPUT_USD_PER_MTOK
  const outputUsd = (opts.outputTokens / 1_000_000) * OPUS_OUTPUT_USD_PER_MTOK
  store.claudeUsd += inputUsd + outputUsd
  store.claudeCalls += 1
  store.claudeInputTokens += opts.inputTokens
  store.claudeOutputTokens += opts.outputTokens
}

export function totalCostUsd(acc: CostAccumulator): number {
  return acc.dataforseoUsd + acc.claudeUsd
}
