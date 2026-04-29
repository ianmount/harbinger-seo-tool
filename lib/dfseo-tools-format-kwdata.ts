import "server-only"

import {
  asObj,
  firstResultAll,
  firstResultItems,
  pickNum,
  pickStr,
  type CsvOutput,
  type FormattedResponse,
} from "@/lib/dfseo-tools-format"

export function formatKwData(
  id: string,
  _params: Record<string, unknown>,
  envelope: unknown,
): FormattedResponse {
  switch (id) {
    case "kwdata-search-volume":
      return searchVolume(envelope)
    case "kwdata-google-trends":
    case "kwdata-dfs-trends":
      return trendsTimeseries(envelope)
  }
  return { markdown: "_(no formatter)_" }
}

function searchVolume(envelope: unknown): FormattedResponse {
  // Search volume puts items at tasks[0].result (no nested .items).
  const items = firstResultAll(envelope)

  // Collect every YYYY-MM that appears across all rows so the CSV is square.
  const monthSet = new Set<string>()
  type Row = {
    keyword: string
    search_volume: number | null
    cpc: number | null
    competition: string
    monthly: Map<string, number>
  }
  const parsed: Row[] = items.map((raw) => {
    const o = asObj(raw)
    const monthly = new Map<string, number>()
    if (Array.isArray(o.monthly_searches)) {
      for (const m of o.monthly_searches as unknown[]) {
        const mObj = asObj(m)
        const year = pickNum(mObj, "year")
        const month = pickNum(mObj, "month")
        const vol = pickNum(mObj, "search_volume")
        if (year != null && month != null && vol != null) {
          const key = `${year}-${String(month).padStart(2, "0")}`
          monthly.set(key, vol)
          monthSet.add(key)
        }
      }
    }
    return {
      keyword: pickStr(o, "keyword"),
      search_volume: pickNum(o, "search_volume"),
      cpc: pickNum(o, "cpc"),
      competition: pickStr(o, "competition"),
      monthly,
    }
  })

  const months = Array.from(monthSet).sort()
  const headers = ["keyword", "search_volume", "cpc", "competition", ...months]
  const rows: CsvOutput["rows"] = parsed.map((r) => [
    r.keyword,
    r.search_volume,
    r.cpc,
    r.competition,
    ...months.map((m) => r.monthly.get(m) ?? null),
  ])
  return { csv: { headers, rows } }
}

function trendsTimeseries(envelope: unknown): FormattedResponse {
  // Trends responses have items[] of blocks with `type` field. We want the
  // graph block (google_trends_graph or dataforseo_trends_graph), which
  // contains `keywords` (string[]) and `data` (array of {date_from, values}
  // where `values` aligns with the `keywords` array).
  const items = firstResultItems(envelope)
  let graph: Record<string, unknown> | null = null
  for (const it of items) {
    const o = asObj(it)
    const t = pickStr(o, "type")
    if (t === "google_trends_graph" || t === "dataforseo_trends_graph") {
      graph = o
      break
    }
  }
  if (!graph) {
    return { csv: { headers: ["timestamp"], rows: [] } }
  }
  const keywords = Array.isArray(graph.keywords)
    ? (graph.keywords as unknown[]).map((k) => String(k))
    : []
  const data = Array.isArray(graph.data) ? (graph.data as unknown[]) : []

  const headers = ["date_from", "date_to", ...keywords]
  const rows: CsvOutput["rows"] = data.map((d) => {
    const o = asObj(d)
    const values = Array.isArray(o.values) ? (o.values as unknown[]) : []
    return [
      pickStr(o, "date_from"),
      pickStr(o, "date_to"),
      ...keywords.map((_, i) => {
        const v = values[i]
        return typeof v === "number" ? v : null
      }),
    ]
  })
  return { csv: { headers, rows } }
}
