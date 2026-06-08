/**
 * Negative-keyword library for the keyword-research curator.
 *
 * The skill ships a categorized `references/negative_keywords.txt`; this is a
 * vendored TypeScript port — a starter set grouped into categories so a run
 * can disable a whole category via `config.disableCategories` (e.g. turn off
 * `manufacturer_brands` for material-driven trades that legitimately want
 * brand/material terms).
 *
 * Matching is word-boundary based (see curate.ts): a candidate is dropped
 * when it contains any active negative token as a whole word/phrase. Keep
 * entries lowercase. Extend freely — no migration needed.
 */

export const NEGATIVE_CATEGORIES: Record<string, readonly string[]> = {
  // Job-seeker / careers intent — not customer demand.
  jobs_careers: [
    "job", "jobs", "career", "careers", "salary", "salaries", "hiring",
    "employment", "resume", "intern", "internship", "apprenticeship",
    "apprentice", "vacancy", "vacancies", "recruitment",
  ],
  // DIY / how-to / educational intent (kept off by default for service demand;
  // disable this category if the strategy explicitly targets content/topical).
  diy_education: [
    "diy", "how to", "how do", "tutorial", "tutorials", "course", "courses",
    "training", "class", "classes", "certification", "certificate", "license",
    "licensing", "exam", "definition", "meaning", "wikipedia",
  ],
  // Free / cheap freebie-seekers.
  freebie: [
    "free", "freeware", "download", "torrent", "crack", "coupon", "coupons",
    "discount code", "promo code",
  ],
  // Product/equipment/material shopping (manufacturer + materials). Disable
  // for material-driven trades (roofing materials, siding brands, etc.).
  manufacturer_brands: [
    "amazon", "home depot", "lowes", "lowe's", "walmart", "menards",
    "wayfair", "ebay", "costco", "harbor freight",
  ],
  // Adult / gambling / clearly-irrelevant noise.
  adult_noise: [
    "porn", "xxx", "sex", "casino", "betting", "lottery",
  ],
  // Reviews/comparison meta-terms that rarely convert for a single local SMB.
  meta_terms: [
    "reddit", "quora", "yelp", "bbb", "scam", "complaints", "lawsuit",
  ],
}

/** Default categories applied unless explicitly disabled per run. */
export const DEFAULT_ACTIVE_CATEGORIES: readonly string[] = [
  "jobs_careers",
  "freebie",
  "adult_noise",
  "meta_terms",
]

/**
 * Resolve the active negative tokens for a run. Starts from the default
 * categories, removes any the run disabled. (Categories not in the default
 * set — like diy_education / manufacturer_brands — stay off unless a future
 * config opts them in; for now disableCategories only subtracts.)
 */
export function activeNegativeTokens(disableCategories: string[]): {
  category: string
  token: string
}[] {
  const disabled = new Set(disableCategories)
  const out: { category: string; token: string }[] = []
  for (const cat of DEFAULT_ACTIVE_CATEGORIES) {
    if (disabled.has(cat)) continue
    for (const token of NEGATIVE_CATEGORIES[cat] ?? []) {
      out.push({ category: cat, token })
    }
  }
  return out
}
