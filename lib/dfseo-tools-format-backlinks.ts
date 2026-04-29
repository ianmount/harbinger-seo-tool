import "server-only"

import {
  asObj,
  firstResult,
  firstResultItems,
  fmtNum,
  mdKvList,
  pickBool,
  pickNum,
  pickStr,
  type FormattedResponse,
} from "@/lib/dfseo-tools-format"

export function formatBacklinks(
  id: string,
  params: Record<string, unknown>,
  envelope: unknown,
): FormattedResponse {
  switch (id) {
    case "backlinks-summary":
      return summary(params, envelope)
    case "backlinks-list":
      return backlinksList(envelope)
    case "referring-domains":
      return referringDomains(envelope)
    case "backlinks-anchors":
      return anchors(envelope)
  }
  return { markdown: "_(no formatter)_" }
}

function summary(
  params: Record<string, unknown>,
  envelope: unknown,
): FormattedResponse {
  const r = asObj(firstResult(envelope))
  const target = pickStr(r, "target") || String(params.target ?? "")
  const md = [
    `# Backlinks Summary — \`${target}\``,
    "",
    mdKvList([
      { label: "Rank", value: pickNum(r, "rank") },
      { label: "Backlinks", value: pickNum(r, "backlinks") },
      { label: "Referring domains", value: pickNum(r, "referring_domains") },
      {
        label: "Referring main domains",
        value: pickNum(r, "referring_main_domains"),
      },
      { label: "Referring pages", value: pickNum(r, "referring_pages") },
      { label: "Referring IPs", value: pickNum(r, "referring_ips") },
      { label: "Referring subnets", value: pickNum(r, "referring_subnets") },
      { label: "Broken backlinks", value: pickNum(r, "broken_backlinks") },
      { label: "Broken pages", value: pickNum(r, "broken_pages") },
      { label: "Dofollow backlinks", value: pickNum(r, "backlinks_dofollow") },
      {
        label: "Backlinks spam score",
        value: pickNum(r, "backlinks_spam_score"),
      },
    ]),
  ].join("\n")
  return { markdown: md }
}

function backlinksList(envelope: unknown): FormattedResponse {
  const items = firstResultItems(envelope)
  const headers = [
    "url_from",
    "url_to",
    "anchor",
    "domain_from",
    "rank",
    "is_new",
    "is_lost",
    "dofollow",
    "first_seen",
    "last_seen",
  ]
  const rows = items.map((raw) => {
    const o = asObj(raw)
    return [
      pickStr(o, "url_from"),
      pickStr(o, "url_to"),
      pickStr(o, "anchor"),
      pickStr(o, "domain_from"),
      pickNum(o, "rank"),
      formatBool(pickBool(o, "is_new")),
      formatBool(pickBool(o, "is_lost")),
      formatBool(pickBool(o, "dofollow")),
      pickStr(o, "first_seen"),
      pickStr(o, "last_seen"),
    ]
  })
  return { csv: { headers, rows } }
}

function referringDomains(envelope: unknown): FormattedResponse {
  const items = firstResultItems(envelope)
  const headers = [
    "domain",
    "rank",
    "backlinks",
    "first_seen",
    "lost_date",
    "referring_pages",
    "backlinks_spam_score",
  ]
  const rows = items.map((raw) => {
    const o = asObj(raw)
    return [
      pickStr(o, "domain"),
      pickNum(o, "rank"),
      pickNum(o, "backlinks"),
      pickStr(o, "first_seen"),
      pickStr(o, "lost_date"),
      pickNum(o, "referring_pages"),
      pickNum(o, "backlinks_spam_score"),
    ]
  })
  return { csv: { headers, rows } }
}

function anchors(envelope: unknown): FormattedResponse {
  const items = firstResultItems(envelope)
  const headers = [
    "anchor",
    "backlinks",
    "referring_domains",
    "dofollow",
    "first_seen",
    "lost_date",
  ]
  const rows = items.map((raw) => {
    const o = asObj(raw)
    return [
      pickStr(o, "anchor"),
      pickNum(o, "backlinks"),
      pickNum(o, "referring_domains"),
      pickNum(o, "dofollow"),
      pickStr(o, "first_seen"),
      pickStr(o, "lost_date"),
    ]
  })
  return { csv: { headers, rows } }
}

function formatBool(b: boolean | null): string {
  if (b == null) return ""
  return b ? "true" : "false"
}

// Re-export so the runner doesn't have to import these helpers separately.
export { fmtNum }
