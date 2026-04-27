import { NextResponse } from "next/server"
import { z } from "zod"
import { callClaude, ClaudeApiError } from "@/lib/claude"
import type {
  AuditSynthesis,
  BacklinkReport,
  CompetitiveReport,
  CrawlReport,
  AuditGa4Slice,
  AuditGscSlice,
  PageSpeedReport,
  Prospect,
} from "@/lib/types"

export const dynamic = "force-dynamic"
export const maxDuration = 300

/**
 * Audit synthesis route.
 *
 * Model: `claude-opus-4-7`. The audit is a long-form judgment-heavy
 * deliverable and the cost lift over Sonnet is justified for the quality
 * gain, especially on the calibrated CTR-uplift narratives where Opus is
 * noticeably better at honoring the "use partner's own data, not industry
 * averages" instruction. We bumped max_tokens to fit ~10K tokens of
 * finished prose. If we hit stream-idle timeouts on very large 16-month
 * payloads, the fallback is shrinking the input (cap topQueries to fewer
 * rows) rather than swapping models.
 */
const AUDIT_MODEL = "claude-opus-4-7"

// ────────────────────────────────────────────────────────────────────────────
// Request schema. Each sub-object is validated loosely (passthrough) because
// the intermediate audit routes are the source of truth for their shapes —
// we just need to pass everything through to the prompt.

const prospectSchema = z.object({
  domain: z.string(),
  targetMarkets: z.array(
    z.object({ city: z.string(), state: z.string() }),
  ),
  competitors: z.array(z.string()),
  gscSiteUrl: z.string().optional(),
  ga4PropertyId: z.string().optional(),
  contactName: z.string().optional(),
})

const bodySchema = z.object({
  prospect: prospectSchema,
  partnerDriven: z.boolean().optional(),
  crawl: z.unknown(),
  competitive: z.unknown(),
  backlinks: z.unknown(),
  gsc: z.unknown().optional().nullable(),
  ga4: z.unknown().optional().nullable(),
  pageSpeed: z.unknown().optional().nullable(),
  gscShortHistory: z.boolean().optional(),
})

interface ParsedBody {
  prospect: Prospect
  partnerDriven: boolean
  crawl: CrawlReport
  competitive: CompetitiveReport
  backlinks: BacklinkReport
  gsc?: AuditGscSlice
  ga4?: AuditGa4Slice
  pageSpeed?: PageSpeedReport
  gscShortHistory: boolean
}

// ────────────────────────────────────────────────────────────────────────────
// Prompt assembly. Keep input tight — Sonnet is plenty smart if the data is
// well-labeled. We explicitly quantify: show counts, not prose descriptions.

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function formatPct(n: number): string {
  const sign = n >= 0 ? "+" : ""
  return `${sign}${n.toFixed(1)}%`
}

function pctDelta(current: number, prior: number): number {
  if (prior <= 0) return current > 0 ? 100 : 0
  return ((current - prior) / prior) * 100
}

function buildCrawlBlock(crawl: CrawlReport): string {
  const lines: string[] = []
  lines.push(
    `# Site crawl (${crawl.crawledCount} pages crawled; sitemap reports ${crawl.sitemapUrls.length} URLs; mode=${crawl.mode})`,
  )
  lines.push(
    `Duration: ${Math.round(crawl.crawlDurationMs / 100) / 10}s. Max pages: ${crawl.maxPages}. Crawl-delay applied: ${crawl.crawlDelaySec}s.`,
  )

  // Status code distribution — sorted by count desc so the dominant bucket
  // shows first. This is the "are most pages 200?" sanity check.
  const distEntries = Object.entries(crawl.statusCodeDistribution).sort(
    (a, b) => b[1] - a[1],
  )
  const distString =
    distEntries.length > 0
      ? distEntries.map(([code, n]) => `${code}: ${n}`).join(", ")
      : "(no responses)"
  lines.push(`Status code distribution: ${distString}`)

  lines.push(`Non-200 pages: ${crawl.nonOkPages.length}`)
  if (crawl.nonOkPages.length > 0) {
    for (const p of crawl.nonOkPages.slice(0, 10)) {
      lines.push(`  - ${p.status} ${truncate(p.url, 120)}`)
    }
  }
  lines.push(`Pages missing titles: ${crawl.missingTitles.length}`)
  for (const u of crawl.missingTitles.slice(0, 5)) lines.push(`  - ${truncate(u, 120)}`)
  lines.push(`Pages missing meta descriptions: ${crawl.missingDescriptions.length}`)
  for (const u of crawl.missingDescriptions.slice(0, 5)) lines.push(`  - ${truncate(u, 120)}`)
  lines.push(`Pages with no canonical tag: ${crawl.missingCanonicals.length}`)
  for (const u of crawl.missingCanonicals.slice(0, 5)) lines.push(`  - ${truncate(u, 120)}`)
  lines.push(
    `Pages with no meaningful schema (no JSON-LD beyond Article/Person/ImageObject): ${crawl.pagesMissingMeaningfulSchema}`,
  )
  lines.push(`Duplicate title groups: ${crawl.duplicateTitles.length}`)
  for (const g of crawl.duplicateTitles.slice(0, 5)) {
    lines.push(`  - "${truncate(g.title, 80)}" on ${g.urls.length} pages: ${g.urls.slice(0, 3).map((u) => truncate(u, 80)).join(", ")}`)
  }
  lines.push(`Duplicate description groups: ${crawl.duplicateDescriptions.length}`)
  for (const g of crawl.duplicateDescriptions.slice(0, 5)) {
    lines.push(`  - "${truncate(g.description, 80)}" on ${g.urls.length} pages`)
  }
  lines.push(`Thin content pages (<300 words): ${crawl.thinContentPages.length}`)
  for (const p of crawl.thinContentPages.slice(0, 5)) {
    lines.push(`  - ${p.wordCount}w ${truncate(p.url, 120)}`)
  }
  lines.push(`Client-rendered SPA shells detected: ${crawl.spaShellPages.length}`)
  for (const u of crawl.spaShellPages.slice(0, 5)) lines.push(`  - ${truncate(u, 120)}`)
  lines.push(`Schema types present: ${crawl.schemaTypesPresent.join(", ") || "none"}`)
  lines.push(`Recommended schema types missing: ${crawl.schemaTypesRecommended.join(", ") || "none"}`)
  lines.push(`Image alt coverage: ${crawl.imageAltCoveragePercent}%`)
  return lines.join("\n")
}

function buildCompetitiveBlock(c: CompetitiveReport): string {
  const lines: string[] = []
  lines.push(`# Competitive visibility (state-level roll-up of target markets)`)
  if (c.competitorsAutoSuggested) {
    lines.push(`NOTE: Competitors were auto-suggested from SERP data — the MD did not supply them.`)
  }
  lines.push(`Target markets: ${c.markets.map((m) => `${m.city}, ${m.state}`).join("; ")}`)
  for (const row of c.rows) {
    lines.push("")
    lines.push(`## ${row.domain}${row.isProspect ? " (PROSPECT)" : ""}`)
    for (const m of row.markets) {
      lines.push(`  - ${m.city}, ${m.state}: ${m.organicKeywords} organic keywords, ${m.organicTraffic.toFixed(0)} est. monthly organic sessions, $${m.organicTrafficCost.toFixed(0)} est. traffic cost`)
      if (m.topKeywords.length > 0) {
        const top = m.topKeywords
          .map((k) => `"${k.keyword}" (pos ${k.position}, vol ${k.searchVolume})`)
          .join("; ")
        lines.push(`    top keywords: ${top}`)
      }
    }
  }
  return lines.join("\n")
}

function buildBacklinkBlock(b: BacklinkReport): string {
  const lines: string[] = []
  lines.push(`# Backlink profile`)
  lines.push(`Domain: ${b.domain}`)
  lines.push(`Total backlinks: ${b.totalBacklinks.toLocaleString()}`)
  lines.push(`Referring domains: ${b.referringDomains.toLocaleString()}`)
  lines.push(`Average spam score: ${b.averageSpamScore}`)
  lines.push(`Referring domains with spam score >= 50: ${b.highSpamCount}`)
  lines.push(`Top high-spam referring domain examples (use THESE exact domain names):`)
  if (b.highSpamExamples.length === 0) {
    lines.push(`  (none — no referring domains above spam score 50)`)
  }
  for (const s of b.highSpamExamples) {
    lines.push(`  - ${s.domain} (spam ${s.spamScore}, ${s.referringPages} referring pages)`)
  }
  lines.push(`Top authority referring domains for context:`)
  for (const s of b.topAuthorityExamples.slice(0, 5)) {
    lines.push(`  - ${s.domain} (rank ${s.rank})`)
  }
  return lines.join("\n")
}

function buildGscBlock(gsc: AuditGscSlice): string {
  const lines: string[] = []
  lines.push(`# Google Search Console`)
  lines.push(`Site: ${gsc.siteUrl}`)
  lines.push(
    `Long-range window: ${gsc.longRange.dateRange.startDate} → ${gsc.longRange.dateRange.endDate}`,
  )
  lines.push(
    `Recent window (calibration): ${gsc.recent.dateRange.startDate} → ${gsc.recent.dateRange.endDate}`,
  )
  lines.push(
    `Long-range totals: ${gsc.longRange.totalClicks.toLocaleString()} clicks, ${gsc.longRange.totalImpressions.toLocaleString()} impressions`,
  )
  lines.push("")

  // Position distribution.
  lines.push(`## Position Distribution (long-range)`)
  for (const b of gsc.analyses.positionDistribution) {
    lines.push(
      `  - Pos ${b.band}: ${b.queryCount.toLocaleString()} queries, ${b.clicks.toLocaleString()} clicks, ${b.impressions.toLocaleString()} impr, ${(b.ctr * 100).toFixed(2)}% CTR`,
    )
  }
  lines.push("")

  // Observed CTR benchmarks — the calibration baseline.
  lines.push(
    `## Partner's OWN observed CTR at top-3 (90-day, by impression tier) — USE THESE FOR EVERY UPLIFT ESTIMATE`,
  )
  for (const t of gsc.analyses.observedCtrTiers) {
    lines.push(
      `  - ${t.tier} impressions: ${t.queryCount} queries, mean CTR ${(t.meanCtr * 100).toFixed(2)}%, median CTR ${(t.medianCtr * 100).toFixed(2)}%${t.lowConfidence ? " (LOW CONFIDENCE — fewer than 5 queries)" : ""}`,
    )
  }
  lines.push("")

  // Page concentration.
  lines.push(`## Power-Page Concentration (long-range)`)
  lines.push(
    `Total pages with clicks: ${gsc.analyses.pageConcentration.totalPages.toLocaleString()} · total clicks: ${gsc.analyses.pageConcentration.totalClicks.toLocaleString()}`,
  )
  for (const b of gsc.analyses.pageConcentration.bands) {
    lines.push(
      `  - Top ${b.topN} pages = ${b.clicks.toLocaleString()} clicks (${b.sharePct.toFixed(1)}% of total)`,
    )
  }
  lines.push(
    `  - It takes ${gsc.analyses.pageConcentration.pagesToHalfOfClicks} pages to reach 50% of total organic clicks.`,
  )
  lines.push("")

  // Quick wins (positions 4-10).
  if (gsc.analyses.quickWins.length > 0) {
    lines.push(
      `## Quick-Win Queries (positions 4–10, calibrated against partner's own top-3 CTR)`,
    )
    for (const q of gsc.analyses.quickWins.slice(0, 25)) {
      lines.push(
        `  - "${truncate(q.query, 70)}" — pos ${q.currentPosition.toFixed(1)}, ${q.currentImpressions.toLocaleString()} impr, ${q.currentClicks} clicks (${(q.currentCtr * 100).toFixed(2)}% CTR), tier ${q.matchedTier}, projected top-3 CTR ${(q.projectedTopThreeCtr * 100).toFixed(2)}%, est. annual uplift +${Math.round(q.upliftAnnualClicks).toLocaleString()} clicks${q.page ? ` (page: ${truncate(q.page, 80)})` : ""}`,
      )
    }
    lines.push("")
  }

  // Mega-impression hubs.
  if (gsc.analyses.megaImpressionHubs.length > 0) {
    lines.push(
      `## Mega-Impression Hub Pages (>=100K impressions, sub-2% CTR)`,
    )
    for (const h of gsc.analyses.megaImpressionHubs) {
      lines.push(
        `  - ${truncate(h.page, 100)} — ${h.impressions.toLocaleString()} impr, ${h.clicks.toLocaleString()} clicks (${(h.ctr * 100).toFixed(2)}% CTR), pos ${h.position.toFixed(1)}, calibrated projected CTR ${(h.projectedCtr * 100).toFixed(2)}%, est. annual additional clicks +${Math.round(h.projectedAdditionalClicks).toLocaleString()}`,
      )
    }
    lines.push("")
  }

  // Top queries (sample for clustering and finding generation).
  lines.push(
    `## Top queries by impressions (long-range, sample of ${Math.min(120, gsc.longRange.topQueries.length)})`,
  )
  const sortedByImpr = [...gsc.longRange.topQueries]
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 120)
  for (const q of sortedByImpr) {
    lines.push(
      `  - ${truncate(q.query, 70)} — ${q.clicks} clk, ${q.impressions.toLocaleString()} impr, ${(q.ctr * 100).toFixed(2)}% CTR, pos ${q.position.toFixed(1)}`,
    )
  }
  lines.push("")

  lines.push(`## Top pages by clicks (long-range)`)
  for (const p of gsc.longRange.topPages.slice(0, 25)) {
    lines.push(
      `  - ${truncate(p.page, 100)} — ${p.clicks.toLocaleString()} clicks, ${p.impressions.toLocaleString()} impr, ${(p.ctr * 100).toFixed(2)}% CTR, pos ${p.position.toFixed(1)}`,
    )
  }
  return lines.join("\n")
}

function buildPageSpeedBlock(report: PageSpeedReport): string {
  const lines: string[] = []
  lines.push(`# PageSpeed Insights (mobile-first; Google ranks on mobile)`)
  if (report.skippedReason) {
    lines.push(report.skippedReason)
    lines.push(
      `Performance section required: no (PageSpeed pass did not run)`,
    )
    return lines.join("\n")
  }
  if (report.pages.length === 0) {
    lines.push(`No pages were audited.`)
    lines.push(
      `Performance section required: no (PageSpeed pass returned no pages)`,
    )
    return lines.join("\n")
  }

  const a = report.aggregates
  lines.push(
    `Pages audited: ${report.pages.length}${report.homepageIncluded ? " (includes homepage)" : ""}`,
  )
  lines.push(
    `Average mobile performance score: ${a.averageMobileScore ?? "n/a"}/100`,
  )
  lines.push(
    `Homepage mobile performance score: ${a.homepageMobileScore ?? "n/a"}/100`,
  )

  const homepageTier1 =
    typeof a.homepageMobileScore === "number" && a.homepageMobileScore < 50
  lines.push(
    `Tier 1 performance finding required: ${homepageTier1 ? "YES — homepage mobile score < 50. Surface in executiveSummary AND keyFindings." : "no"}`,
  )

  const anyBelow70 = report.pages.some(
    (p) =>
      typeof p.mobile?.performanceScore === "number" &&
      p.mobile.performanceScore < 70,
  )
  lines.push(
    `Performance section required: ${anyBelow70 ? "YES — at least one audited page has mobile score < 70. Emit synthesis.performance with a narrative." : "no"}`,
  )

  if (a.lowScorePages.length > 0) {
    lines.push("")
    lines.push(`## Pages with mobile performance score < 50`)
    for (const p of a.lowScorePages) {
      lines.push(`  - ${truncate(p.url, 120)} — score ${p.score}/100`)
    }
  }
  if (a.poorLcpPages.length > 0) {
    lines.push("")
    lines.push(`## Pages with mobile LCP > 2.5s`)
    for (const p of a.poorLcpPages) {
      lines.push(
        `  - ${truncate(p.url, 120)} — LCP ${(p.lcpMs / 1000).toFixed(2)}s`,
      )
    }
  }
  if (a.poorClsPages.length > 0) {
    lines.push("")
    lines.push(`## Pages with mobile CLS > 0.1`)
    for (const p of a.poorClsPages) {
      lines.push(`  - ${truncate(p.url, 120)} — CLS ${p.cls.toFixed(3)}`)
    }
  }

  lines.push("")
  lines.push(`## Per-page mobile metrics`)
  for (const p of report.pages) {
    const m = p.mobile
    if (!m) {
      lines.push(`  - ${truncate(p.url, 120)} — mobile data unavailable`)
      continue
    }
    const lcp =
      typeof m.lcpMs === "number" ? `${(m.lcpMs / 1000).toFixed(2)}s` : "n/a"
    const inp = typeof m.inpMs === "number" ? `${m.inpMs}ms` : "n/a"
    const cls = typeof m.cls === "number" ? m.cls.toFixed(3) : "n/a"
    const ttfb = typeof m.ttfbMs === "number" ? `${m.ttfbMs}ms` : "n/a"
    const score =
      typeof m.performanceScore === "number" ? `${m.performanceScore}/100` : "n/a"
    lines.push(
      `  - ${truncate(p.url, 100)} — score ${score}, LCP ${lcp}, INP ${inp}, CLS ${cls}, TTFB ${ttfb}`,
    )
    if (m.opportunities.length > 0) {
      const opps = m.opportunities
        .map(
          (o) =>
            `${o.title}${typeof o.estimatedSavingsMs === "number" ? ` (save ~${(o.estimatedSavingsMs / 1000).toFixed(2)}s)` : ""}`,
        )
        .join("; ")
      lines.push(`      top opportunities: ${opps}`)
    }
  }
  return lines.join("\n")
}

function buildGa4Block(ga4: AuditGa4Slice): string {
  const lines: string[] = []
  const cur = ga4.currentYear
  lines.push(
    `# Google Analytics 4 — last 12 months (${cur.dateRange.startDate} → ${cur.dateRange.endDate})`,
  )
  lines.push(`Sessions: ${cur.sessions.toLocaleString()}`)
  lines.push(`Users: ${cur.users.toLocaleString()}`)
  lines.push(
    `Conversions: ${cur.conversions.toLocaleString()} (configured: ${cur.conversionsConfigured})`,
  )

  // Channel breakdown — useful for "how organic-dependent is this partner?".
  if (ga4.channelBreakdown.length > 0) {
    lines.push("")
    lines.push(`## Sessions by default channel grouping (last 12 months)`)
    const totalSess = ga4.channelBreakdown.reduce((s, c) => s + c.sessions, 0)
    for (const c of ga4.channelBreakdown) {
      const share = totalSess > 0 ? (c.sessions / totalSess) * 100 : 0
      lines.push(
        `  - ${c.channel}: ${c.sessions.toLocaleString()} sessions (${share.toFixed(1)}%), ${c.conversions.toLocaleString()} conversions`,
      )
    }
  }

  // Monthly organic — seasonality + recent trajectory.
  if (ga4.monthlyOrganic.length > 0) {
    lines.push("")
    lines.push(`## Monthly organic sessions (for seasonality)`)
    for (const m of ga4.monthlyOrganic) {
      lines.push(
        `  - ${m.month}: ${m.sessions.toLocaleString()} sessions, ${m.conversions.toLocaleString()} conversions`,
      )
    }
  }

  // YoY against prior 12 months.
  if (ga4.priorYear) {
    const p = ga4.priorYear
    lines.push("")
    lines.push(
      `## YoY vs. prior year (${p.dateRange.startDate} → ${p.dateRange.endDate})`,
    )
    lines.push(
      `Prior: ${p.sessions.toLocaleString()} sessions, ${p.users.toLocaleString()} users, ${p.conversions.toLocaleString()} conversions`,
    )
    lines.push(
      `Deltas: sessions ${formatPct(pctDelta(cur.sessions, p.sessions))}, users ${formatPct(pctDelta(cur.users, p.users))}, conversions ${formatPct(pctDelta(cur.conversions, p.conversions))}`,
    )

    const priorByPage = new Map(
      p.topLandingPages.map((lp) => [lp.landingPage, lp]),
    )
    const losses: {
      page: string
      current: number
      prior: number
      delta: number
    }[] = []
    for (const lp of cur.topLandingPages) {
      const prior = priorByPage.get(lp.landingPage)
      if (!prior || prior.sessions <= 10) continue
      const delta = pctDelta(lp.sessions, prior.sessions)
      if (delta < -5) {
        losses.push({
          page: lp.landingPage,
          current: lp.sessions,
          prior: prior.sessions,
          delta,
        })
      }
    }
    losses.sort((a, b) => a.delta - b.delta)
    if (losses.length > 0) {
      lines.push("")
      lines.push(`### Top landing pages that LOST sessions YoY`)
      for (const l of losses.slice(0, 10)) {
        lines.push(
          `  - ${truncate(l.page, 100)} — ${l.current} current vs. ${l.prior} prior (${formatPct(l.delta)})`,
        )
      }
    }
  }

  if (cur.organicOnly.length > 0) {
    lines.push("")
    lines.push(`## Organic landing pages (current 12 months)`)
    for (const lp of cur.organicOnly.slice(0, 15)) {
      lines.push(
        `  - ${truncate(lp.landingPage, 100)} — ${lp.sessions.toLocaleString()} sess, ${lp.conversions.toLocaleString()} conv, ${(lp.conversionRate * 100).toFixed(2)}% rate`,
      )
    }
  }
  return lines.join("\n")
}

// ────────────────────────────────────────────────────────────────────────────
// The actual prompt.

const SYSTEM_PROMPT = `You are a senior SEO analyst producing an SEO audit for Harbinger Marketing. The audit is delivered as a polished PDF.

The audit can run in two modes:
  - PARTNER MODE: GSC + GA4 are connected and you have rich first-party data. Produce a calibrated, data-grounded audit with quantified uplift estimates. This is the default.
  - PRE-SALES MODE: no GSC/GA4 access. Run on crawl + DataForSEO + competitor signals only. Clearly flag that the audit is running on third-party estimates and explicitly note the limitation in the executive summary.

HARD CONSTRAINTS (violations cause the audit to be rejected):
1. Produce EXACTLY 5–7 key findings. If more exist, push extras into appendixIssues as one-liners.
2. Every finding MUST cite a specific URL, count, percentage, or query taken VERBATIM from the data provided. Generic statements are forbidden.
3. At least ONE finding must reference a competitor domain by name.
4. backlinkRisk must list 3–5 actual spammy domain examples using exact domain strings from the data. If fewer than 3 exist, say so honestly.
5. If GA4 conversions are configured: traffic findings MUST translate to leads/revenue in plain language (e.g. "230 fewer organic sessions/month ≈ 9 fewer lead forms at the site's 4% conversion rate"). If conversions are not configured or GA4 is absent, acknowledge the gap rather than inventing a number.
6. The 90-day roadmap must reference findings by number using "#N" format.
7. No generic recommendations. Specify the exact pages, queries, and metrics being addressed.

PERFORMANCE RULES (apply when the PageSpeed Insights block is present):
P1. When the PageSpeed block reports "Performance section required: YES", populate the synthesis "performance" object with a 2-3 sentence narrative that names the worst-performing audited page by URL, calls out the average mobile score, and recommends 1-2 of the top opportunities returned for that page. Echo the server-computed lowScorePages / poorLcpPages / poorClsPages lists verbatim.
P2. When the PageSpeed block reports "Tier 1 performance finding required: YES" (homepage mobile score < 50), the homepage performance issue MUST appear (a) in executiveSummary as one of the headline takeaways and (b) as a numbered Key Finding with a headlineMetric of the form "Homepage mobile score: N/100" citing the exact URL of the homepage. The Tier 1 rule is independent of the indexation Tier 1 rule — both can fire at once.
P3. When the PageSpeed block was skipped or no page is below 70, omit the synthesis "performance" object entirely (set it to null).
P4. Every performance recommendation cites a specific URL and a specific metric value taken VERBATIM from the PageSpeed block. No generic "improve LCP" guidance.

CALIBRATION RULES (apply when GSC is connected):
A. Every CTR uplift estimate MUST be calibrated against the partner's OWN observed CTR at top-3 by impression tier (provided in the GSC block under "Partner's OWN observed CTR at top-3"). DO NOT use industry CTR averages. DO NOT cite Backlinko / Sistrix / Advanced Web Ranking studies. The partner's data is the only source of truth.
B. Be honest about AI Overview suppression: high-impression informational queries (10K+ impressions) will NOT earn 30%+ CTR at top-3 even with perfect titles. Numbers in your output must reflect that — a 6–12% top-3 CTR is realistic for high-impression queries today.
C. Quick-win and mega-impression-hub uplift figures have already been pre-calculated server-side using the calibrated tiers. You may cite the calculated figures verbatim. If you produce additional uplift estimates of your own, calibrate them the same way.
D. When GSC history is short (gscShortHistory=true), seasonality commentary MUST acknowledge the data limitation rather than fabricate a trend.

TOPIC CLUSTERING:
Cluster the long-range top-queries list into 5–10 topic groups based on user intent and subject matter. For each cluster report queryCount, totalClicks, totalImpressions, averageCtr, averagePosition (averages weighted by impressions). Identify ONE cluster as highestLeverageCluster — the one with high impressions and below-average CTR — and explain WHY in the narrative.

LOCAL PERFORMANCE:
For each target market (city + state in prospect.targetMarkets), report counts derived from filtering GSC queries by city tokens. If GSC is absent, report DataForSEO-derived counts instead and flag the source.

OUTPUT FORMAT: return ONLY a single JSON object (no preamble, no trailing text, no markdown fences) matching the schema in the user message. JSON must be valid and parseable.`

function buildUserPrompt(body: ParsedBody): string {
  const {
    prospect,
    partnerDriven,
    crawl,
    competitive,
    backlinks,
    gsc,
    ga4,
    pageSpeed,
  } = body
  const lines: string[] = []

  lines.push(`# Audit subject`)
  lines.push(`Mode: ${partnerDriven ? "PARTNER (auto-resolved GSC/GA4)" : "PRE-SALES (third-party data only unless GSC/GA4 supplied)"}`)
  lines.push(`Domain: ${prospect.domain}`)
  if (prospect.contactName) lines.push(`Name: ${prospect.contactName}`)
  lines.push(
    `Target markets: ${prospect.targetMarkets.map((m) => `${m.city}, ${m.state}`).join("; ")}`,
  )
  lines.push(
    `Competitors provided: ${prospect.competitors.length > 0 ? prospect.competitors.join(", ") : "(none — auto-suggested)"}`,
  )
  lines.push(`GSC access: ${gsc ? "yes" : "no — fall back to third-party estimates and FLAG the gap"}`)
  lines.push(`GA4 access: ${ga4 ? "yes" : "no — fall back to third-party estimates and FLAG the gap"}`)
  lines.push(
    `PageSpeed access: ${pageSpeed && !pageSpeed.skippedReason ? "yes" : "no — performance section will be omitted"}`,
  )
  if (body.gscShortHistory) {
    lines.push(
      `GSC short-history flag: TRUE — long-range window covers <6 months. Cap seasonality commentary accordingly.`,
    )
  }
  lines.push("")

  lines.push(buildCrawlBlock(crawl))
  lines.push("")
  lines.push(buildCompetitiveBlock(competitive))
  lines.push("")
  lines.push(buildBacklinkBlock(backlinks))
  if (gsc) {
    lines.push("")
    lines.push(buildGscBlock(gsc))
  }
  if (ga4) {
    lines.push("")
    lines.push(buildGa4Block(ga4))
  }
  if (pageSpeed) {
    lines.push("")
    lines.push(buildPageSpeedBlock(pageSpeed))
  }

  lines.push("")
  lines.push(`# Output schema (return ONLY this JSON, no markdown fences, no preamble)`)
  lines.push("```json")
  lines.push(
    JSON.stringify(
      {
        prospectDomain: "<prospect domain, verbatim>",
        prospectName: "<optional prospect/contact name>",
        generatedAt: "<ISO 8601 timestamp>",
        executiveSummary:
          "<2-3 sentences. Set up the audit: what you looked at, the single most important conclusion. No fluff.>",
        keyFindings: [
          {
            number: 1,
            title: "<short, punchy>",
            detail: "<1-2 sentences. MUST cite URL, count, or %.>",
            headlineMetric: "<the single number that matters, e.g. '230 pages' or '-42%'>",
            businessImpact:
              "<optional. lead/revenue framing if GA4 conversions available; otherwise omit>",
          },
        ],
        appendixIssues: [
          "<one-line summaries of issues that didn't make the top 7>",
        ],
        trafficAnalysis: ga4
          ? {
              summary: "<1-2 sentence read of the YoY traffic story>",
              sessionsCurrent: 0,
              sessionsPrior: 0,
              sessionsDeltaPct: 0,
              conversionsCurrent: 0,
              conversionsPrior: 0,
              conversionsDeltaPct: 0,
              nuance:
                "<optional. 'Good news buried in bad' signal — e.g. engagement up while sessions down.>",
              topPagesLost: [
                { page: "<url>", sessionsLost: 0, deltaPct: 0 },
              ],
            }
          : null,
        keywordVisibility: {
          markets: [{ city: "<city>", state: "<state>" }],
          rows: [
            {
              domain: "<domain>",
              isProspect: false,
              perMarket: [
                {
                  city: "<city>",
                  state: "<state>",
                  organicKeywords: 0,
                  organicTraffic: 0,
                },
              ],
            },
          ],
          narrative:
            "<1-2 sentences naming at least one competitor domain and describing the visibility gap>",
        },
        topPagesToRecover: ga4
          ? [{ page: "<url>", reasoning: "<why this page matters>" }]
          : null,
        technicalFindings: [
          {
            title: "<short>",
            evidence: "<specific URL or count from the crawl data>",
            businessImpact: "<why the prospect should care in business terms>",
          },
        ],
        backlinkRisk: {
          summary: "<1-2 sentences>",
          averageSpamScore: 0,
          highSpamCount: 0,
          spamExamples: ["<exact spammy domain 1>", "<exact spammy domain 2>"],
        },
        roadmap: [
          {
            phase: "Month 1",
            title: "<short>",
            description:
              "<MUST reference findings by #N, e.g. 'Resolves Finding #3'>",
            findingRefs: [3],
          },
          { phase: "Month 2", title: "", description: "", findingRefs: [] },
          { phase: "Month 3", title: "", description: "", findingRefs: [] },
        ],
        positionDistribution: gsc
          ? {
              bands: gsc.analyses.positionDistribution,
              narrative:
                "<2-3 sentences reading the table. Name the band that holds the most opportunity.>",
            }
          : null,
        observedCtrBenchmarks: gsc
          ? {
              tiers: gsc.analyses.observedCtrTiers,
              narrative:
                "<2-3 sentences. Acknowledge AI Overview suppression on high-impression tiers explicitly. State that THESE are the calibration baseline used for every uplift estimate in this report.>",
            }
          : null,
        ctrOpportunity: gsc
          ? {
              estimatedAnnualClickUplift: 0,
              contributingQueryCount: 0,
              narrative:
                "<3-4 sentences. Total uplift from moving the quick-win queries to top-3, calibrated against the partner's own observed CTRs (NOT industry averages). Be honest: high-impression queries earn lower CTRs at top-3 due to AI Overview suppression. Cite the calibrated tier numbers.>",
            }
          : null,
        pageConcentration: gsc
          ? {
              bands: gsc.analyses.pageConcentration.bands,
              pagesToHalfOfClicks: gsc.analyses.pageConcentration.pagesToHalfOfClicks,
              narrative:
                "<2-3 sentences. Frame concentration as algorithm-update vulnerability if it's high. State the 'pages to 50%' number.>",
            }
          : null,
        topicClusters: gsc
          ? {
              clusters: [
                {
                  name: "<cluster name, e.g. 'Drain repair'>",
                  queryCount: 0,
                  totalClicks: 0,
                  totalImpressions: 0,
                  averageCtr: 0,
                  averagePosition: 0,
                  notes: "<1 sentence read>",
                },
              ],
              highestLeverageCluster: "<the cluster name with high impressions and below-avg CTR>",
              narrative:
                "<2-3 sentences. Why is the highest-leverage cluster underperforming? What content move resolves it?>",
            }
          : null,
        quickWins: gsc
          ? {
              queries: gsc.analyses.quickWins.slice(0, 12),
              narrative:
                "<2-3 sentences. Why these specifically? What's the common bottleneck (title, intro, schema)?>",
            }
          : null,
        megaImpressionHubs: gsc
          ? {
              pages: gsc.analyses.megaImpressionHubs,
              narrative:
                "<2-3 sentences. Why title/meta rewrites here are the highest-ROI move. Reference AI Overview reality.>",
            }
          : null,
        localPerformance: gsc
          ? {
              rows: prospect.targetMarkets.map((m) => ({
                city: m.city,
                state: m.state,
                rankingsCount: 0,
                topThreeCount: 0,
                totalClicks: 0,
                totalImpressions: 0,
              })),
              narrative:
                "<2-3 sentences naming the strongest and weakest market by GSC click volume.>",
            }
          : null,
        performance:
          pageSpeed &&
          !pageSpeed.skippedReason &&
          pageSpeed.pages.some(
            (p) =>
              typeof p.mobile?.performanceScore === "number" &&
              p.mobile.performanceScore < 70,
          )
            ? {
                averageMobileScore: pageSpeed.aggregates.averageMobileScore,
                homepageMobileScore: pageSpeed.aggregates.homepageMobileScore,
                lowScorePages: pageSpeed.aggregates.lowScorePages,
                poorLcpPages: pageSpeed.aggregates.poorLcpPages,
                poorClsPages: pageSpeed.aggregates.poorClsPages,
                narrative:
                  "<2-3 sentences. Name the worst-scoring audited URL, cite its mobile score, and recommend 1-2 of the top opportunities listed for it. If homepage mobile < 50, frame it as the lead headline.>",
              }
            : null,
        dataSources: {
          crawlPagesAnalyzed: 0,
          gscIncluded: Boolean(gsc),
          ga4Included: Boolean(ga4),
          gscShortHistory: Boolean(body.gscShortHistory),
          competitorsAutoSuggested: competitive.competitorsAutoSuggested,
          partnerDriven: Boolean(body.partnerDriven),
          pageSpeedIncluded: Boolean(pageSpeed && !pageSpeed.skippedReason),
        },
      },
      null,
      2,
    ),
  )
  lines.push("```")

  return lines.join("\n")
}

// ────────────────────────────────────────────────────────────────────────────
// JSON extraction — Sonnet sometimes wraps output in ```json fences despite
// instructions. Strip fences, then parse.

function extractJson(text: string): unknown {
  const trimmed = text.trim()
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  const raw = fence ? fence[1] : trimmed
  return JSON.parse(raw)
}

// Loose validator — we trust Claude's structural output but defensively check
// the two hard-limit invariants (5-7 findings, every finding has the
// required fields). If they're violated, return a 502 with a useful message
// so the UI can retry rather than crashing the PDF render.
function validateSynthesis(parsed: unknown): AuditSynthesis {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Claude output was not a JSON object")
  }
  const obj = parsed as AuditSynthesis
  if (!Array.isArray(obj.keyFindings)) {
    throw new Error("keyFindings missing or not an array")
  }
  if (obj.keyFindings.length < 5 || obj.keyFindings.length > 7) {
    throw new Error(
      `keyFindings must have 5–7 entries, got ${obj.keyFindings.length}`,
    )
  }
  for (const f of obj.keyFindings) {
    if (typeof f.number !== "number" || !f.title || !f.detail || !f.headlineMetric) {
      throw new Error("a keyFinding is missing number/title/detail/headlineMetric")
    }
  }
  if (!obj.keywordVisibility || typeof obj.keywordVisibility.narrative !== "string") {
    throw new Error("keywordVisibility.narrative missing")
  }
  if (!obj.backlinkRisk || !Array.isArray(obj.backlinkRisk.spamExamples)) {
    throw new Error("backlinkRisk.spamExamples missing")
  }
  if (!Array.isArray(obj.roadmap) || obj.roadmap.length === 0) {
    throw new Error("roadmap missing or empty")
  }
  return obj
}

export async function POST(request: Request) {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON" },
      { status: 400 },
    )
  }
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request body", issues: parsed.error.flatten() },
      { status: 400 },
    )
  }

  const body = {
    ...(parsed.data as unknown as ParsedBody),
    partnerDriven: parsed.data.partnerDriven ?? false,
    gscShortHistory: parsed.data.gscShortHistory ?? false,
  } as ParsedBody

  try {
    const prompt = buildUserPrompt(body)
    // Opus 4.7 — long-form deliverable, ~10K output tokens of finished prose
    // plus the structured JSON wrapper. Cost is justified by the quality lift
    // on calibrated-uplift narratives.
    const text = await callClaude(prompt, {
      model: AUDIT_MODEL,
      system: SYSTEM_PROMPT,
      maxTokens: 16_000,
    })

    let parsedJson: unknown
    try {
      parsedJson = extractJson(text)
    } catch (err) {
      console.error(
        "[api/claude/audit] failed to parse JSON from Claude output:",
        err,
        "\nRaw output start:\n",
        text.slice(0, 500),
      )
      return NextResponse.json(
        { error: "Claude output was not valid JSON. Retry the audit." },
        { status: 502 },
      )
    }

    let synthesis: AuditSynthesis
    try {
      synthesis = validateSynthesis(parsedJson)
    } catch (err) {
      console.error(
        "[api/claude/audit] synthesis failed schema check:",
        err,
        "\nParsed keys:",
        Object.keys(parsedJson as object ?? {}),
      )
      return NextResponse.json(
        {
          error:
            err instanceof Error
              ? `Audit synthesis invalid: ${err.message}. Retry the audit.`
              : "Audit synthesis invalid. Retry the audit.",
        },
        { status: 502 },
      )
    }

    synthesis.generatedAt = synthesis.generatedAt ?? new Date().toISOString()

    return NextResponse.json({ synthesis })
  } catch (error) {
    console.error("[api/claude/audit] failed:", error)
    if (error instanceof ClaudeApiError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status ?? 502 },
      )
    }
    const message = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
