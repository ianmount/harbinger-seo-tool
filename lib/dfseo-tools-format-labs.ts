import "server-only"

import {
  asObj,
  firstResultItems,
  pickNum,
  pickStr,
  type FormattedResponse,
} from "@/lib/dfseo-tools-format"

export function formatLabs(
  id: string,
  _params: Record<string, unknown>,
  envelope: unknown,
): FormattedResponse {
  switch (id) {
    case "labs-keyword-ideas":
    case "labs-keyword-suggestions":
      return keywordList(envelope)
    case "labs-keyword-overview":
      return keywordOverview(envelope)
    case "labs-ranked-keywords":
      return rankedKeywords(envelope)
    case "labs-serp-competitors":
      return serpCompetitors(envelope)
  }
  return { markdown: "_(no formatter)_" }
}

function keywordList(envelope: unknown): FormattedResponse {
  const items = firstResultItems(envelope)
  const headers = [
    "keyword",
    "search_volume",
    "cpc",
    "competition",
    "competition_level",
    "keyword_difficulty",
  ]
  const rows = items.map((raw) => {
    const o = asObj(raw)
    const info = asObj(o.keyword_info)
    const props = asObj(o.keyword_properties)
    return [
      pickStr(o, "keyword"),
      pickNum(info, "search_volume"),
      pickNum(info, "cpc"),
      pickNum(info, "competition"),
      pickStr(info, "competition_level"),
      pickNum(props, "keyword_difficulty") ?? pickNum(o, "keyword_difficulty"),
    ]
  })
  return { csv: { headers, rows } }
}

function keywordOverview(envelope: unknown): FormattedResponse {
  const items = firstResultItems(envelope)
  const headers = [
    "keyword",
    "search_volume",
    "cpc",
    "competition",
    "competition_level",
    "low_top_of_page_bid",
    "high_top_of_page_bid",
    "keyword_difficulty",
    "search_intent",
  ]
  const rows = items.map((raw) => {
    const o = asObj(raw)
    const info = asObj(o.keyword_info)
    const props = asObj(o.keyword_properties)
    const intent = asObj(o.search_intent_info)
    return [
      pickStr(o, "keyword"),
      pickNum(info, "search_volume"),
      pickNum(info, "cpc"),
      pickNum(info, "competition"),
      pickStr(info, "competition_level"),
      pickNum(info, "low_top_of_page_bid"),
      pickNum(info, "high_top_of_page_bid"),
      pickNum(props, "keyword_difficulty") ?? pickNum(o, "keyword_difficulty"),
      pickStr(intent, "main_intent"),
    ]
  })
  return { csv: { headers, rows } }
}

function rankedKeywords(envelope: unknown): FormattedResponse {
  const items = firstResultItems(envelope)
  const headers = [
    "keyword",
    "rank_absolute",
    "rank_group",
    "search_volume",
    "cpc",
    "url",
    "etv",
  ]
  const rows = items.map((raw) => {
    const o = asObj(raw)
    const kd = asObj(o.keyword_data)
    const info = asObj(kd.keyword_info)
    const ranked = asObj(o.ranked_serp_element)
    const serp = asObj(ranked.serp_item)
    return [
      pickStr(kd, "keyword"),
      pickNum(serp, "rank_absolute"),
      pickNum(serp, "rank_group"),
      pickNum(info, "search_volume"),
      pickNum(info, "cpc"),
      pickStr(serp, "url"),
      pickNum(serp, "etv"),
    ]
  })
  return { csv: { headers, rows } }
}

function serpCompetitors(envelope: unknown): FormattedResponse {
  const items = firstResultItems(envelope)
  const headers = [
    "domain",
    "avg_position",
    "sum_position",
    "intersections",
    "visibility",
    "relevance",
    "median_position",
  ]
  const rows = items.map((raw) => {
    const o = asObj(raw)
    return [
      pickStr(o, "domain"),
      pickNum(o, "avg_position"),
      pickNum(o, "sum_position"),
      pickNum(o, "intersections"),
      pickNum(o, "visibility"),
      pickNum(o, "relevance"),
      pickNum(o, "median_position"),
    ]
  })
  return { csv: { headers, rows } }
}
