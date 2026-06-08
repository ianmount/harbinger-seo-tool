/**
 * Keyword-research curator (refine phase).
 *
 * Turns the raw national candidate pull (keyword_suggestions +
 * related_keywords, per seed) into one curated prospect list the user
 * reviews before any paid per-city work. Ported from the skill's
 * `curate_candidates.py --mode refine`:
 *
 *   1. Cluster each seed's items by core_keyword (fallback: lowercased
 *      keyword); keep the highest-volume member, record variant_count.
 *   2. Filter three ways, in order: out-of-market geo allowlist, the
 *      negative-keyword library, and the competitor brand denylist.
 *   3. Narrow each seed to `depth` by source priority (suggestions >
 *      related) → intent → national volume.
 *   4. Curate to `target_plan_size`, balanced across seeds (round-robin),
 *      deduped globally by keyword.
 *
 * Every dropped term is recorded with a reason so the caller can surface a
 * drop log for false-positive skimming.
 */

import type {
  KeywordCandidate,
  KeywordDrop,
  KeywordIntent,
  KeywordResearchConfig,
  KeywordResult,
  KeywordSource,
} from "@/lib/types"
import { expandStateToken, getGazetteer } from "./gazetteer"
import { activeNegativeTokens } from "./negatives"

export interface RawCandidate {
  seed: string
  source: KeywordSource
  result: KeywordResult
}

export interface CurateOutput {
  prospect: KeywordCandidate[]
  drops: KeywordDrop[]
}

const SOURCE_PRIORITY: Record<KeywordSource, number> = {
  suggestions: 0,
  related: 1,
}

// Lower = stronger for local-service demand.
const INTENT_PRIORITY: Record<KeywordIntent, number> = {
  transactional: 0,
  commercial: 1,
  navigational: 2,
  informational: 3,
}

function intentRank(intent: KeywordIntent | null | undefined): number {
  return intent ? INTENT_PRIORITY[intent] : 4
}

function normalize(s: string): string {
  return s.trim().toLowerCase()
}

function words(keyword: string): string[] {
  return normalize(keyword)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/** Build the lowercased allowlist of in-market place tokens + phrases. */
function buildAllowlist(config: KeywordResearchConfig): Set<string> {
  const allow = new Set<string>()
  for (const c of config.market.cities) {
    const n = normalize(c)
    if (n) allow.add(n)
  }
  for (const s of config.market.states) {
    for (const form of expandStateToken(s)) allow.add(form)
  }
  for (const e of config.market.extraAllow) {
    const n = normalize(e)
    if (n) allow.add(n)
  }
  return allow
}

/**
 * Returns the out-of-market place found in the keyword, or null when the
 * keyword is geo-clean or only references in-market places.
 */
function outOfMarketPlace(
  keyword: string,
  allow: Set<string>,
): string | null {
  const gaz = getGazetteer()
  const lower = normalize(keyword)
  // Phrases first (multi-word cities / two-word states), longest already first.
  for (const phrase of gaz.phrases) {
    // Word-boundary-ish: phrase surrounded by start/end or non-alphanumerics.
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(phrase)}([^a-z0-9]|$)`)
    if (re.test(lower) && !allow.has(phrase)) return phrase
  }
  for (const w of words(keyword)) {
    if (gaz.singleTokens.has(w) && !allow.has(w)) return w
  }
  return null
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Tokenize a competitor business name into matchable brand tokens. */
function competitorTokens(competitors: string[]): string[] {
  const stop = new Set([
    "the", "and", "of", "llc", "inc", "co", "company", "services", "service",
    "group", "your",
  ])
  const out = new Set<string>()
  for (const name of competitors) {
    const ws = words(name).filter((w) => w.length > 2 && !stop.has(w))
    // Whole normalized name (spaces collapsed) + individual distinctive words.
    const whole = ws.join(" ")
    if (whole) out.add(whole)
    for (const w of ws) out.add(w)
  }
  return [...out]
}

function clusterKey(result: KeywordResult): string {
  return normalize(result.core_keyword || result.keyword)
}

function toCandidate(
  seed: string,
  source: KeywordSource,
  result: KeywordResult,
  variantCount: number,
): KeywordCandidate {
  return {
    seed,
    keyword: result.keyword.trim(),
    source,
    coreKeyword: normalize(result.core_keyword || result.keyword),
    variantCount,
    nationalVolume: result.search_volume ?? null,
    keywordDifficulty: result.keyword_difficulty ?? null,
    searchIntent: result.search_intent ?? null,
    cpc: result.cpc ?? null,
    competition: result.competition ?? null,
    competitionLevel: result.competition_level ?? null,
  }
}

export function curateCandidates(
  raw: RawCandidate[],
  config: KeywordResearchConfig,
): CurateOutput {
  const allow = buildAllowlist(config)
  const negatives = activeNegativeTokens(config.disableCategories)
  const compTokens = competitorTokens(config.competitors)
  const drops: KeywordDrop[] = []

  // ── Step 1: cluster per (seed, core_keyword). ────────────────────────────
  // bySeed → Map<coreKey, members[]>
  const bySeed = new Map<string, Map<string, RawCandidate[]>>()
  for (const rc of raw) {
    if (!rc.result.keyword?.trim()) continue
    const seedMap = bySeed.get(rc.seed) ?? new Map<string, RawCandidate[]>()
    if (!bySeed.has(rc.seed)) bySeed.set(rc.seed, seedMap)
    const key = clusterKey(rc.result)
    const members = seedMap.get(key) ?? []
    if (!seedMap.has(key)) seedMap.set(key, members)
    members.push(rc)
  }

  // Per seed, collapse clusters to one representative candidate.
  const perSeedCandidates = new Map<string, KeywordCandidate[]>()
  for (const [seed, seedMap] of bySeed) {
    const candidates: KeywordCandidate[] = []
    for (const members of seedMap.values()) {
      // Distinct keyword strings drive variant_count.
      const distinctKeywords = new Set(
        members.map((m) => normalize(m.result.keyword)),
      )
      // Representative: highest national volume; ties broken by source.
      const rep = [...members].sort((a, b) => {
        const av = a.result.search_volume ?? 0
        const bv = b.result.search_volume ?? 0
        if (bv !== av) return bv - av
        return SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source]
      })[0]
      // Best source present in the cluster (suggestions wins).
      const bestSource: KeywordSource = members.some(
        (m) => m.source === "suggestions",
      )
        ? "suggestions"
        : "related"
      candidates.push(
        toCandidate(seed, bestSource, rep.result, distinctKeywords.size),
      )
    }
    perSeedCandidates.set(seed, candidates)
  }

  // ── Step 2: filter (geo → negatives → competitors). ──────────────────────
  const filteredBySeed = new Map<string, KeywordCandidate[]>()
  for (const [seed, candidates] of perSeedCandidates) {
    const kept: KeywordCandidate[] = []
    for (const c of candidates) {
      const place = outOfMarketPlace(c.keyword, allow)
      if (place) {
        drops.push({ keyword: c.keyword, seed, reason: `out-of-market: ${place}` })
        continue
      }
      const neg = negatives.find((n) => containsToken(c.keyword, n.token))
      if (neg) {
        drops.push({
          keyword: c.keyword,
          seed,
          reason: `negative (${neg.category}): ${neg.token}`,
        })
        continue
      }
      const comp = compTokens.find((t) => containsToken(c.keyword, t))
      if (comp) {
        drops.push({ keyword: c.keyword, seed, reason: `competitor brand: ${comp}` })
        continue
      }
      kept.push(c)
    }
    filteredBySeed.set(seed, kept)
  }

  // ── Step 3: narrow each seed to `depth`. ─────────────────────────────────
  for (const [seed, kept] of filteredBySeed) {
    kept.sort(compareCandidates)
    if (kept.length > config.depth) {
      for (const c of kept.slice(config.depth)) {
        drops.push({ keyword: c.keyword, seed, reason: "beyond depth cutoff" })
      }
      filteredBySeed.set(seed, kept.slice(0, config.depth))
    }
  }

  // ── Step 4: balance to target_plan_size across seeds (round-robin). ───────
  const seeds = [...filteredBySeed.keys()]
  const cursors = new Map(seeds.map((s) => [s, 0]))
  const takenKeywords = new Set<string>()
  const prospect: KeywordCandidate[] = []
  let exhausted = false
  while (prospect.length < config.targetPlanSize && !exhausted) {
    exhausted = true
    for (const seed of seeds) {
      if (prospect.length >= config.targetPlanSize) break
      const list = filteredBySeed.get(seed) ?? []
      let i = cursors.get(seed) ?? 0
      // Advance past already-taken keywords (claimed by an earlier seed).
      while (i < list.length && takenKeywords.has(normalize(list[i].keyword))) {
        i++
      }
      if (i < list.length) {
        const c = list[i]
        takenKeywords.add(normalize(c.keyword))
        prospect.push(c)
        cursors.set(seed, i + 1)
        exhausted = false
      } else {
        cursors.set(seed, i)
      }
    }
  }

  // Anything left in the per-seed lists that didn't make the plan is an
  // implicit drop, but we don't log those individually (the report shows the
  // counts). Sort the final prospect by seed then volume for a stable view.
  prospect.sort((a, b) => {
    if (a.seed !== b.seed) return a.seed.localeCompare(b.seed)
    return (b.nationalVolume ?? 0) - (a.nationalVolume ?? 0)
  })

  return { prospect, drops }
}

function compareCandidates(a: KeywordCandidate, b: KeywordCandidate): number {
  // source priority → intent → national volume desc.
  const sp = SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source]
  if (sp !== 0) return sp
  const ir = intentRank(a.searchIntent) - intentRank(b.searchIntent)
  if (ir !== 0) return ir
  return (b.nationalVolume ?? 0) - (a.nationalVolume ?? 0)
}

/** Whole-word / phrase containment, case-insensitive. */
function containsToken(keyword: string, token: string): boolean {
  const re = new RegExp(
    `(^|[^a-z0-9])${escapeRegex(token.toLowerCase())}([^a-z0-9]|$)`,
  )
  return re.test(normalize(keyword))
}
