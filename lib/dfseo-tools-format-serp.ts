import "server-only"

import {
  asObj,
  firstResult,
  firstResultItems,
  fmtNum,
  mdKvList,
  pickNum,
  pickStr,
  type FormattedResponse,
} from "@/lib/dfseo-tools-format"

export function formatSerp(
  id: string,
  _params: Record<string, unknown>,
  envelope: unknown,
): FormattedResponse {
  switch (id) {
    case "serp-google-organic":
      return googleOrganic(envelope)
    case "serp-youtube-organic":
      return youtubeOrganic(envelope)
    case "serp-youtube-video-info":
      return youtubeVideoInfo(envelope)
  }
  return { markdown: "_(no formatter)_" }
}

function googleOrganic(envelope: unknown): FormattedResponse {
  const items = firstResultItems(envelope)
  const headers = [
    "rank_absolute",
    "rank_group",
    "type",
    "domain",
    "url",
    "title",
    "description",
  ]
  const rows = items.map((raw) => {
    const o = asObj(raw)
    return [
      pickNum(o, "rank_absolute"),
      pickNum(o, "rank_group"),
      pickStr(o, "type"),
      pickStr(o, "domain"),
      pickStr(o, "url"),
      pickStr(o, "title"),
      pickStr(o, "description"),
    ]
  })
  return { csv: { headers, rows } }
}

function youtubeOrganic(envelope: unknown): FormattedResponse {
  const items = firstResultItems(envelope)
  const headers = [
    "rank_absolute",
    "type",
    "title",
    "url",
    "channel_name",
    "views_count",
    "description",
  ]
  const rows = items.map((raw) => {
    const o = asObj(raw)
    return [
      pickNum(o, "rank_absolute"),
      pickStr(o, "type"),
      pickStr(o, "title"),
      pickStr(o, "url"),
      pickStr(o, "channel_name"),
      pickNum(o, "views_count"),
      pickStr(o, "description"),
    ]
  })
  return { csv: { headers, rows } }
}

function youtubeVideoInfo(envelope: unknown): FormattedResponse {
  // Result shape varies — sometimes tasks[0].result[0].items[0],
  // sometimes tasks[0].result[0]. Walk both.
  const r = asObj(firstResult(envelope))
  const items = Array.isArray(r.items) ? (r.items as unknown[]) : []
  const v = asObj(items[0] ?? r)

  const tags = Array.isArray(v.tags)
    ? (v.tags as unknown[]).map((t) => String(t)).join(", ")
    : ""

  const md = [
    `# YouTube Video — ${pickStr(v, "title") || "(untitled)"}`,
    "",
    "## Overview",
    "",
    mdKvList([
      { label: "Channel", value: pickStr(v, "channel_name") },
      { label: "Published", value: pickStr(v, "publication_date") },
      { label: "Duration", value: pickStr(v, "duration_time") },
      { label: "Views", value: pickNum(v, "views_count") },
      { label: "Likes", value: pickNum(v, "likes_count") },
      { label: "Comments", value: pickNum(v, "comments_count") },
      { label: "URL", value: pickStr(v, "video_url") },
    ]),
    "",
    "## Description",
    "",
    pickStr(v, "description") || "_(no description)_",
    "",
    "## Tags",
    "",
    tags || "_(no tags)_",
  ].join("\n")

  return { markdown: md }
}

// Re-export to keep the import surface predictable.
export { fmtNum }
