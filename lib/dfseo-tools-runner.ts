import "server-only"

import { dfsRequest } from "@/lib/dataforseo"
import { formatResponse } from "@/lib/dfseo-tools-format"
import { getToolSpec, type ToolField, type ToolSpec } from "@/lib/dfseo-tools"

/**
 * Server-only runner for the "DataForSEO APIs" tool tab.
 *
 * Given a tool id and a params dict from the client form, this validates the
 * params against the spec, builds the DFS payload, calls the DFS endpoint via
 * the shared `dfsRequest` helper, and returns the response in either Markdown
 * or CSV form depending on the spec's `output` field.
 *
 * Each endpoint has its own response transformer because shapes vary
 * significantly. Keeping them all here means the client just renders whatever
 * comes back.
 */

export type CsvOutput = {
  headers: string[]
  rows: (string | number | null)[][]
}

export type ToolRunResult = {
  endpoint: string
  /** What the response status_message reported, useful for debugging. */
  statusMessage: string
  /** DFS-reported envelope cost in USD (null when the API didn't surface one). */
  costUsd: number | null
  /** "md" or "csv" — mirrors ToolSpec.output for the client. */
  outputKind: "md" | "csv"
  /** Populated when outputKind === "md". */
  markdown?: string
  /** Populated when outputKind === "csv". */
  csv?: CsvOutput
}

export class ToolValidationError extends Error {
  readonly issues: string[]
  constructor(message: string, issues: string[] = []) {
    super(message)
    this.name = "ToolValidationError"
    this.issues = issues
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Param coercion + validation.

function coerceField(field: ToolField, raw: unknown): unknown {
  switch (field.kind) {
    case "text":
    case "textarea": {
      if (raw == null || raw === "") return undefined
      if (typeof raw !== "string") {
        throw new ToolValidationError(`${field.label} must be a string`)
      }
      const trimmed = raw.trim()
      if (!trimmed) return undefined
      if (field.max != null && trimmed.length > field.max) {
        throw new ToolValidationError(
          `${field.label} exceeds max length ${field.max}`,
        )
      }
      return trimmed
    }
    case "number": {
      if (raw == null || raw === "") return undefined
      const n =
        typeof raw === "number"
          ? raw
          : typeof raw === "string"
            ? Number(raw)
            : NaN
      if (!Number.isFinite(n)) {
        throw new ToolValidationError(`${field.label} must be a number`)
      }
      if (field.min != null && n < field.min) {
        throw new ToolValidationError(
          `${field.label} must be ≥ ${field.min}`,
        )
      }
      if (field.max != null && n > field.max) {
        throw new ToolValidationError(
          `${field.label} must be ≤ ${field.max}`,
        )
      }
      return n
    }
    case "boolean": {
      if (raw == null) return undefined
      return Boolean(raw)
    }
    case "select": {
      if (raw == null || raw === "") return undefined
      if (typeof raw !== "string") {
        throw new ToolValidationError(`${field.label} must be a string`)
      }
      const allowed = field.options?.map((o) => o.value) ?? []
      if (!allowed.includes(raw)) {
        throw new ToolValidationError(
          `${field.label} must be one of: ${allowed.join(", ")}`,
        )
      }
      return raw
    }
    case "string-array": {
      if (raw == null) return undefined
      let arr: string[]
      if (Array.isArray(raw)) {
        arr = raw.map((x) => String(x).trim()).filter((s) => s.length > 0)
      } else if (typeof raw === "string") {
        arr = raw
          .split(/[\n,]/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      } else {
        throw new ToolValidationError(
          `${field.label} must be a list of strings`,
        )
      }
      if (arr.length === 0) return undefined
      if (field.maxItems != null && arr.length > field.maxItems) {
        arr = arr.slice(0, field.maxItems)
      }
      return arr
    }
    case "location": {
      if (raw == null || raw === "") return undefined
      const n =
        typeof raw === "number"
          ? raw
          : typeof raw === "string"
            ? Number(raw)
            : NaN
      if (!Number.isFinite(n) || n <= 0) {
        throw new ToolValidationError(
          `${field.label} must be a positive integer location_code`,
        )
      }
      return n
    }
  }
}

function validateParams(
  spec: ToolSpec,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of spec.fields) {
    let value = coerceField(field, params[field.name])
    if (value === undefined && field.default !== undefined) {
      value = field.default
    }
    if (value === undefined) {
      if (field.required) {
        throw new ToolValidationError(`${field.label} is required`)
      }
      continue
    }
    out[field.name] = value
  }
  return out
}

function extractVideoId(s: string): string {
  let v = s.trim()
  if (v.includes("watch?v=")) {
    v = v.split("watch?v=")[1].split("&")[0]
  } else if (v.includes("youtu.be/")) {
    v = v.split("youtu.be/")[1].split("?")[0]
  }
  return v
}

// ────────────────────────────────────────────────────────────────────────────
// Main runner.

export async function runDfseoTool(
  toolId: string,
  rawParams: Record<string, unknown>,
): Promise<ToolRunResult> {
  const spec = getToolSpec(toolId)
  if (!spec) {
    throw new ToolValidationError(`Unknown tool id: ${toolId}`)
  }
  const params = validateParams(spec, rawParams)

  const envelope = await dfsRequest(spec.endpoint, buildDfsPayload(spec, params))

  const formatted = formatResponse(spec, params, envelope)

  // dfsRequest already validated `cost` and `status_message` on the envelope
  // shape, but it returns the loosely-typed DfsEnvelope. We only need the
  // top-level cost + message here, so a narrow read is fine.
  const e = envelope as { status_message: string; cost?: number }

  return {
    endpoint: spec.endpoint,
    statusMessage: e.status_message,
    costUsd: e.cost ?? null,
    outputKind: spec.output,
    ...formatted,
  }
}

function buildDfsPayload(
  spec: ToolSpec,
  params: Record<string, unknown>,
): unknown[] {
  // Each endpoint has its own payload shape — most are direct copies of
  // params, but several need targeted reshaping (LLM mentions wraps `target`
  // in an array of objects, ranked_keywords needs a `filters` array, etc.).
  switch (spec.id) {
    case "labs-ranked-keywords": {
      const { max_rank, ...rest } = params as { max_rank?: number } & Record<
        string,
        unknown
      >
      const body: Record<string, unknown> = { ...rest }
      if (typeof max_rank === "number") {
        body.filters = [
          ["ranked_serp_element.serp_item.rank_absolute", "<=", max_rank],
        ]
      }
      return [body]
    }
    case "ai-llm-mentions-search":
    case "ai-llm-mentions-aggregated": {
      const { target_kind, target_value, search_scope, ...rest } = params as {
        target_kind?: string
        target_value?: string
        search_scope?: string
      } & Record<string, unknown>
      const targetEntry: Record<string, unknown> = {
        [target_kind === "domain" ? "domain" : "keyword"]: target_value,
      }
      if (search_scope) targetEntry.search_scope = [search_scope]
      const body: Record<string, unknown> = {
        ...rest,
        target: [targetEntry],
      }
      if (spec.id === "ai-llm-mentions-search") {
        body.order_by = ["ai_search_volume,desc"]
      }
      return [body]
    }
    case "serp-youtube-video-info": {
      const { video_id, ...rest } = params as { video_id?: string } & Record<
        string,
        unknown
      >
      return [
        {
          ...rest,
          video_id: video_id ? extractVideoId(video_id) : video_id,
        },
      ]
    }
    case "onpage-lighthouse": {
      // Spec defaults categories to the four most useful; user only flips
      // the for_mobile flag in our form.
      return [
        {
          ...params,
          categories: ["performance", "accessibility", "best-practices", "seo"],
        },
      ]
    }
    case "ai-llm-chatgpt":
    case "ai-llm-claude":
    case "ai-llm-gemini":
    case "ai-llm-perplexity": {
      // Drop empty system_message / web_search_country_iso_code so DFS
      // doesn't reject them.
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(params)) {
        if (v === "" || v == null) continue
        out[k] = v
      }
      return [out]
    }
    default:
      return [params]
  }
}

// formatResponse and per-endpoint transformers live in dfseo-tools-format.ts
