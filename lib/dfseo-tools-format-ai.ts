import "server-only"

import {
  asObj,
  firstResult,
  firstResultItems,
  fmtNum,
  pickNum,
  pickStr,
  type CsvOutput,
  type FormattedResponse,
} from "@/lib/dfseo-tools-format"

export function formatAi(
  id: string,
  _params: Record<string, unknown>,
  envelope: unknown,
): FormattedResponse {
  switch (id) {
    case "ai-keyword-volume":
      return aiKeywordVolume(envelope)
    case "ai-llm-mentions-search":
      return llmMentionsSearch(envelope)
    case "ai-llm-mentions-aggregated":
      return llmMentionsAggregated(envelope)
    case "ai-chatgpt-scraper":
      return chatgptScraper(envelope)
    case "ai-llm-chatgpt":
    case "ai-llm-claude":
    case "ai-llm-gemini":
    case "ai-llm-perplexity":
      return llmResponse(envelope)
  }
  return { markdown: "_(no formatter)_" }
}

function aiKeywordVolume(envelope: unknown): FormattedResponse {
  const items = firstResultItems(envelope)
  const monthSet = new Set<string>()
  type Row = {
    keyword: string
    ai_search_volume: number | null
    monthly: Map<string, number>
  }
  const parsed: Row[] = items.map((raw) => {
    const o = asObj(raw)
    const monthly = new Map<string, number>()
    if (Array.isArray(o.ai_monthly_searches)) {
      for (const m of o.ai_monthly_searches as unknown[]) {
        const mObj = asObj(m)
        const year = pickNum(mObj, "year")
        const month = pickNum(mObj, "month")
        const vol = pickNum(mObj, "ai_search_volume")
        if (year != null && month != null && vol != null) {
          const key = `${year}-${String(month).padStart(2, "0")}`
          monthly.set(key, vol)
          monthSet.add(key)
        }
      }
    }
    return {
      keyword: pickStr(o, "keyword"),
      ai_search_volume: pickNum(o, "ai_search_volume"),
      monthly,
    }
  })

  const months = Array.from(monthSet).sort()
  const headers = ["keyword", "ai_search_volume", ...months]
  const rows: CsvOutput["rows"] = parsed.map((r) => [
    r.keyword,
    r.ai_search_volume,
    ...months.map((m) => r.monthly.get(m) ?? null),
  ])
  return { csv: { headers, rows } }
}

function llmMentionsSearch(envelope: unknown): FormattedResponse {
  const items = firstResultItems(envelope)
  const headers = [
    "keyword",
    "platform",
    "ai_search_volume",
    "question",
    "answer",
    "sources",
    "non_cited_sources_count",
    "first_response_at",
    "last_response_at",
  ]
  const rows = items.map((raw) => {
    const o = asObj(raw)
    const sources = Array.isArray(o.sources) ? (o.sources as unknown[]) : []
    const sourceUrls = sources
      .map((s) => pickStr(asObj(s), "url"))
      .filter((u) => u.length > 0)
      .join(" | ")
    const nonCited = Array.isArray(o.non_cited_sources)
      ? (o.non_cited_sources as unknown[]).length
      : 0
    return [
      pickStr(o, "keyword"),
      pickStr(o, "platform"),
      pickNum(o, "ai_search_volume"),
      pickStr(o, "question"),
      pickStr(o, "answer"),
      sourceUrls,
      nonCited,
      pickStr(o, "first_response_at"),
      pickStr(o, "last_response_at"),
    ]
  })
  return { csv: { headers, rows } }
}

function llmMentionsAggregated(envelope: unknown): FormattedResponse {
  const r = asObj(firstResult(envelope))
  const total = asObj(r.total)
  const sections: string[] = []
  for (const [groupKey, group] of Object.entries(total)) {
    const list = Array.isArray(group) ? (group as unknown[]) : []
    if (list.length === 0) continue
    sections.push(`## Grouped by \`${groupKey}\``)
    sections.push("")
    sections.push("| Key | Mentions | AI search volume | Impressions |")
    sections.push("|---|---:|---:|---:|")
    for (const g of list) {
      const o = asObj(g)
      sections.push(
        `| ${pickStr(o, "key") || "—"} | ${fmtNum(pickNum(o, "mentions"))} | ${fmtNum(pickNum(o, "ai_search_volume"))} | ${fmtNum(pickNum(o, "impressions"))} |`,
      )
    }
    sections.push("")
  }
  const md = [
    "# LLM Mentions — Aggregated Metrics",
    "",
    sections.length > 0 ? sections.join("\n") : "_(no aggregated data)_",
  ].join("\n")
  return { markdown: md }
}

function chatgptScraper(envelope: unknown): FormattedResponse {
  const items = firstResultItems(envelope)
  const item = asObj(items[0])
  const markdown = pickStr(item, "markdown")
  const inner = Array.isArray(item.items) ? (item.items as unknown[]) : []
  const annotations: string[] = []
  for (const it of inner) {
    const o = asObj(it)
    if (pickStr(o, "type") === "annotation") {
      const url = pickStr(o, "url") || pickStr(asObj(o.url_citation), "url")
      const title =
        pickStr(o, "title") || pickStr(asObj(o.url_citation), "title")
      if (url) annotations.push(`- [${title || url}](${url})`)
    }
  }
  const md = [
    `# ChatGPT Response — ${pickStr(item, "keyword") || "(no keyword)"}`,
    "",
    pickStr(item, "model") ? `_Model: ${pickStr(item, "model")}_` : "",
    "",
    markdown || "_(empty response)_",
    "",
    annotations.length > 0 ? "## Cited sources" : "",
    annotations.length > 0 ? annotations.join("\n") : "",
  ]
    .filter((line) => line !== "")
    .join("\n")
  return { markdown: md }
}

function llmResponse(envelope: unknown): FormattedResponse {
  const items = firstResultItems(envelope)
  const item = asObj(items[0])
  const sectionsArr = Array.isArray(item.sections)
    ? (item.sections as unknown[])
    : []
  const body = sectionsArr
    .map((s) => pickStr(asObj(s), "content"))
    .filter((t) => t.length > 0)
    .join("\n\n")

  const annotationsArr = Array.isArray(item.annotations)
    ? (item.annotations as unknown[])
    : []
  const annotationLines: string[] = []
  for (const a of annotationsArr) {
    const o = asObj(a)
    const url = pickStr(o, "url")
    const title = pickStr(o, "title")
    if (url) annotationLines.push(`- [${title || url}](${url})`)
  }

  const model = pickStr(item, "model_name") || pickStr(item, "model")
  const inputTokens = pickNum(item, "input_tokens")
  const outputTokens = pickNum(item, "output_tokens")
  const moneySpent = pickNum(item, "money_spent")

  const meta = [
    model ? `_Model: ${model}_` : "",
    inputTokens != null
      ? `_Tokens: ${fmtNum(inputTokens)} in / ${fmtNum(outputTokens)} out_`
      : "",
    moneySpent != null ? `_Cost: $${moneySpent.toFixed(6)}_` : "",
  ].filter((s) => s.length > 0)

  const md = [
    "# LLM Response",
    "",
    meta.join(" · "),
    "",
    body || "_(empty response)_",
    "",
    annotationLines.length > 0 ? "## Cited sources" : "",
    annotationLines.length > 0 ? annotationLines.join("\n") : "",
  ]
    .filter((line) => line !== "")
    .join("\n")

  return { markdown: md }
}
