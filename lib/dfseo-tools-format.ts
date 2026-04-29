import "server-only"

import type { ToolSpec } from "@/lib/dfseo-tools"

export type CsvOutput = {
  headers: string[]
  rows: (string | number | null)[][]
}

export type FormattedResponse = {
  markdown?: string
  csv?: CsvOutput
}

// ── Helpers ────────────────────────────────────────────────────────────────

export function asObj(x: unknown): Record<string, unknown> {
  return x && typeof x === "object" && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : {}
}

export function pickStr(o: Record<string, unknown>, key: string): string {
  const v = o[key]
  return typeof v === "string" ? v : ""
}

export function pickNum(o: Record<string, unknown>, key: string): number | null {
  const v = o[key]
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

export function pickBool(
  o: Record<string, unknown>,
  key: string,
): boolean | null {
  const v = o[key]
  return typeof v === "boolean" ? v : null
}

export function firstResult(envelope: unknown): unknown {
  const e = asObj(envelope)
  const tasks = Array.isArray(e.tasks) ? (e.tasks as unknown[]) : []
  const task = asObj(tasks[0])
  const result = Array.isArray(task.result) ? (task.result as unknown[]) : []
  return result[0] ?? null
}

export function firstResultAll(envelope: unknown): unknown[] {
  const e = asObj(envelope)
  const tasks = Array.isArray(e.tasks) ? (e.tasks as unknown[]) : []
  const task = asObj(tasks[0])
  return Array.isArray(task.result) ? (task.result as unknown[]) : []
}

export function firstResultItems(envelope: unknown): unknown[] {
  const r = asObj(firstResult(envelope))
  const items = r.items
  return Array.isArray(items) ? items : []
}

export function fmtNum(n: number | null | undefined): string {
  if (n == null) return "—"
  if (Number.isInteger(n)) return n.toLocaleString()
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 })
}

export function mdEscape(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ")
}

export function mdKvList(
  rows: { label: string; value: string | number | null | undefined }[],
): string {
  return rows
    .map((r) => {
      const v =
        r.value == null
          ? "—"
          : typeof r.value === "number"
            ? fmtNum(r.value)
            : r.value
      return `- **${r.label}:** ${v}`
    })
    .join("\n")
}

// ── Dispatcher ─────────────────────────────────────────────────────────────

import { formatBacklinks } from "@/lib/dfseo-tools-format-backlinks"
import { formatLabs } from "@/lib/dfseo-tools-format-labs"
import { formatKwData } from "@/lib/dfseo-tools-format-kwdata"
import { formatSerp } from "@/lib/dfseo-tools-format-serp"
import { formatOnPage } from "@/lib/dfseo-tools-format-onpage"
import { formatAi } from "@/lib/dfseo-tools-format-ai"

export function formatResponse(
  spec: ToolSpec,
  params: Record<string, unknown>,
  envelope: unknown,
): FormattedResponse {
  const id = spec.id
  if (id.startsWith("backlinks-") || id === "referring-domains") {
    return formatBacklinks(id, params, envelope)
  }
  if (id.startsWith("labs-")) {
    return formatLabs(id, params, envelope)
  }
  if (id.startsWith("kwdata-")) {
    return formatKwData(id, params, envelope)
  }
  if (id.startsWith("serp-")) {
    return formatSerp(id, params, envelope)
  }
  if (id.startsWith("onpage-")) {
    return formatOnPage(id, params, envelope)
  }
  if (id.startsWith("ai-")) {
    return formatAi(id, params, envelope)
  }
  return {
    markdown: `# Response\n\nNo formatter for tool id "${id}".\n\n\`\`\`json\n${JSON.stringify(envelope, null, 2).slice(0, 4000)}\n\`\`\``,
  }
}
