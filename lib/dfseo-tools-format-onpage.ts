import "server-only"

import {
  asObj,
  firstResult,
  firstResultItems,
  mdKvList,
  pickNum,
  pickStr,
  type FormattedResponse,
} from "@/lib/dfseo-tools-format"

export function formatOnPage(
  id: string,
  _params: Record<string, unknown>,
  envelope: unknown,
): FormattedResponse {
  switch (id) {
    case "onpage-instant":
      return instantPage(envelope)
    case "onpage-lighthouse":
      return lighthouse(envelope)
    case "onpage-content-parsing":
      return contentParsing(envelope)
  }
  return { markdown: "_(no formatter)_" }
}

function instantPage(envelope: unknown): FormattedResponse {
  const items = firstResultItems(envelope)
  const page = asObj(items[0])
  const meta = asObj(page.meta)
  const content = asObj(meta.content)
  const checks = asObj(page.checks)

  const failingChecks = Object.entries(checks)
    .filter(([, v]) => v === true)
    .map(([k]) => k)
    .sort()

  const md = [
    `# Instant Page Audit — ${pickStr(page, "url") || "(no url)"}`,
    "",
    "## Page",
    "",
    mdKvList([
      { label: "Status code", value: pickNum(page, "status_code") },
      { label: "Size (bytes)", value: pickNum(page, "size") },
      { label: "Total DOM size", value: pickNum(page, "total_dom_size") },
    ]),
    "",
    "## Meta",
    "",
    mdKvList([
      { label: "Title", value: pickStr(meta, "title") },
      { label: "Title length", value: pickNum(meta, "title_length") },
      { label: "Description", value: pickStr(meta, "description") },
      {
        label: "Description length",
        value: pickNum(meta, "description_length"),
      },
      { label: "Canonical", value: pickStr(meta, "canonical") },
      { label: "H1", value: pickStr(meta, "h1") },
      { label: "Internal links", value: pickNum(meta, "internal_links_count") },
      { label: "External links", value: pickNum(meta, "external_links_count") },
      { label: "Images", value: pickNum(meta, "images_count") },
      { label: "Scripts", value: pickNum(meta, "scripts_count") },
      { label: "Stylesheets", value: pickNum(meta, "stylesheets_count") },
      {
        label: "Word count (plain text)",
        value: pickNum(content, "plain_text_word_count"),
      },
    ]),
    "",
    "## Failing checks",
    "",
    failingChecks.length === 0
      ? "_(none — all checks passed)_"
      : failingChecks.map((c) => `- \`${c}\``).join("\n"),
  ].join("\n")

  return { markdown: md }
}

function lighthouse(envelope: unknown): FormattedResponse {
  const r = asObj(firstResult(envelope))
  const categories = asObj(r.categories)
  const audits = asObj(r.audits)

  const categoryRows: { label: string; value: string }[] = []
  for (const [, c] of Object.entries(categories)) {
    const cObj = asObj(c)
    const score = pickNum(cObj, "score")
    const title = pickStr(cObj, "title")
    if (!title) continue
    categoryRows.push({
      label: title,
      value: score == null ? "—" : `${Math.round(score * 100)}/100`,
    })
  }

  type AuditRow = { id: string; title: string; score: number; description: string }
  const failing: AuditRow[] = []
  for (const [id, a] of Object.entries(audits)) {
    const aObj = asObj(a)
    const score = pickNum(aObj, "score")
    if (score == null || score >= 1) continue
    failing.push({
      id,
      title: pickStr(aObj, "title"),
      score,
      description: pickStr(aObj, "description"),
    })
  }
  failing.sort((a, b) => a.score - b.score)

  const md = [
    `# Lighthouse Audit — ${pickStr(r, "finalUrl") || pickStr(r, "requestedUrl") || "(no url)"}`,
    "",
    "## Category scores",
    "",
    categoryRows.length === 0
      ? "_(no scores)_"
      : categoryRows
          .map((c) => `- **${c.label}:** ${c.value}`)
          .join("\n"),
    "",
    "## Audits with score < 1",
    "",
    failing.length === 0
      ? "_(none)_"
      : failing
          .slice(0, 30)
          .map(
            (a) =>
              `- **${a.title || a.id}** (score ${a.score.toFixed(2)})\n  - ${
                a.description.slice(0, 280)
              }`,
          )
          .join("\n"),
  ].join("\n")

  return { markdown: md }
}

function contentParsing(envelope: unknown): FormattedResponse {
  const items = firstResultItems(envelope)
  const page = asObj(items[0])
  const content = asObj(page.page_content)

  const headerInfo = asObj(content.header)
  const headerTopics = Array.isArray(headerInfo.main_topic)
    ? (headerInfo.main_topic as unknown[])
    : []

  const sections = Array.isArray(content.main_topic)
    ? (content.main_topic as unknown[])
    : []

  const headingsBlock = headerTopics.length
    ? headerTopics
        .map((h) => {
          const o = asObj(h)
          const level = pickNum(o, "level") ?? 1
          const title = pickStr(o, "h_title") || pickStr(o, "text") || ""
          return `${"#".repeat(Math.max(1, Math.min(6, level + 1)))} ${title}`
        })
        .join("\n")
    : "_(no headings)_"

  const sectionBlocks = sections.length
    ? sections
        .map((s) => {
          const o = asObj(s)
          const title = pickStr(o, "h_title") || "(section)"
          const paras = Array.isArray(o.primary_content)
            ? (o.primary_content as unknown[])
            : []
          const text = paras
            .map((p) => pickStr(asObj(p), "text"))
            .filter((t) => t.length > 0)
            .join("\n\n")
          return `## ${title}\n\n${text || "_(no content)_"}`
        })
        .join("\n\n")
    : "_(no sections)_"

  const md = [
    `# Content Parsing — ${pickStr(page, "url") || "(no url)"}`,
    "",
    `**Primary topic:** ${pickStr(content, "primary_topic") || "—"}`,
    "",
    "## Heading outline",
    "",
    headingsBlock,
    "",
    "## Sections",
    "",
    sectionBlocks,
  ].join("\n")

  return { markdown: md }
}
