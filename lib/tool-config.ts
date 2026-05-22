/**
 * Single source of truth for the SEMRush-style tool surface.
 *
 * Drives:
 *   - SideNav (primary categories, secondary tool lists)
 *   - Tool page metadata (heading, description shown on each page)
 *   - Type-safe route generation
 *
 * Each `Tool` declares the primary DataForSEO endpoint it hits, plus
 * optional secondary endpoints from the original spec that aren't wired
 * up yet — those serve as a hand-off list for the next iteration.
 */

import type { ComponentType } from "react"
import {
  Bot,
  FolderOpen,
  Globe,
  Link2,
  MapPin,
  Search,
  TrendingUp,
  Users,
  type LucideProps,
} from "lucide-react"

export type ToolCategorySlug =
  | "partners"
  | "keywords"
  | "backlinks"
  | "technical"
  | "competitive"
  | "local"
  | "ai"
  | "other"

export type Tool = {
  slug: string
  category: ToolCategorySlug
  label: string
  description: string
  /** Absolute path inside the app. Includes the category prefix. */
  href: string
  /** Endpoints in spec (first = primary, rest = deferred). */
  endpoints: readonly string[]
}

export type ToolCategory = {
  slug: ToolCategorySlug
  label: string
  icon: ComponentType<LucideProps>
  tools: readonly Tool[]
}

export const TOOL_CATEGORIES: readonly ToolCategory[] = [
  {
    slug: "partners",
    label: "Partners",
    icon: Users,
    tools: [
      {
        slug: "list",
        category: "partners",
        label: "All Partners",
        description:
          "Every partner onboarded to the tool. Click a partner to open their workspace — saved keyword lists, strategies, content briefs, backlink prospects, reports, and technical crawls all live in their folder.",
        href: "/partners",
        endpoints: [],
      },
      {
        slug: "onboard",
        category: "partners",
        label: "Onboard Partner",
        description:
          "Add a new partner to the tool. Collect their profile and link their Google Search Console site and GA4 property from one of the two authorized Google accounts.",
        href: "/partners/new",
        endpoints: [],
      },
    ],
  },
  {
    slug: "keywords",
    label: "Keywords",
    icon: Search,
    tools: [
      {
        slug: "overview",
        category: "keywords",
        label: "Keyword Overview",
        description:
          "Single-keyword deep dive: volume, difficulty, CPC, intent, 12-month trend, per-city volume, SERP composition, features, PAA, related and phrase-match suggestions.",
        href: "/keywords/overview",
        endpoints: [
          "/v3/dataforseo_labs/google/keyword_overview/live",
          "/v3/dataforseo_labs/google/historical_keyword_data/live",
          "/v3/dataforseo_labs/google/search_intent/live",
          "/v3/keywords_data/google_ads/search_volume/live",
          "/v3/serp/google/organic/live/advanced",
          "/v3/dataforseo_labs/google/related_keywords/live",
          "/v3/dataforseo_labs/google/keyword_suggestions/live",
          "/v3/backlinks/bulk_ranks/live",
        ],
      },
      {
        slug: "magic",
        category: "keywords",
        label: "Keyword Research",
        description:
          "Discover keyword ideas, suggestions, and related terms from a seed keyword.",
        href: "/keywords/magic",
        endpoints: [
          "/v3/dataforseo_labs/google/keyword_suggestions/live",
          "/v3/dataforseo_labs/google/keyword_ideas/live",
          "/v3/dataforseo_labs/google/related_keywords/live",
          "/v3/keywords_data/google_ads/search_volume/live",
        ],
      },
      {
        slug: "faq-research",
        category: "keywords",
        label: "FAQ Research",
        description:
          "Mine a list of seed keywords for FAQ-worthy questions. Harvests question-phrase keyword suggestions and related terms, pulls People Also Ask boxes from SERPs at click depth 4, clusters near-duplicates across seeds, and enriches the survivors with search volume, intent, and a frequency-weighted score.",
        href: "/keywords/faq-research",
        endpoints: [
          "/v3/dataforseo_labs/google/keyword_suggestions/live",
          "/v3/dataforseo_labs/google/related_keywords/live",
          "/v3/serp/google/organic/live/advanced",
          "/v3/dataforseo_labs/google/keyword_overview/live",
          "/v3/dataforseo_labs/google/search_intent/live",
        ],
      },
    ],
  },
  {
    slug: "backlinks",
    label: "Backlinks",
    icon: Link2,
    tools: [
      {
        slug: "overview",
        category: "backlinks",
        label: "Backlink Overview",
        description:
          "Domain-wide backlink dashboard: toxic-domain headline (count of referring domains above spam_score 50), summary counts, top referring domains, anchor distribution, new vs lost over time, and referring networks.",
        href: "/backlinks/overview",
        endpoints: [
          "/v3/backlinks/summary/live",
          "/v3/backlinks/referring_domains/live",
          "/v3/backlinks/anchors/live",
          "/v3/backlinks/timeseries_new_lost_summary/live",
          "/v3/backlinks/referring_networks/live",
        ],
      },
      {
        slug: "list",
        category: "backlinks",
        label: "Backlinks List",
        description:
          "Inbound links pointing at a domain or URL with anchor text and link type.",
        href: "/backlinks/list",
        endpoints: [
          "/v3/backlinks/backlinks/live",
          "/v3/backlinks/anchors/live",
        ],
      },
      {
        slug: "referring-domains",
        category: "backlinks",
        label: "Referring Domains",
        description:
          "Domains and networks that link to the target, with rank and link counts.",
        href: "/backlinks/referring-domains",
        endpoints: [
          "/v3/backlinks/referring_domains/live",
          "/v3/backlinks/referring_networks/live",
        ],
      },
      {
        slug: "link-building",
        category: "backlinks",
        label: "Link Building",
        description:
          "Find domains linking to competitors but not you, and pages with intersecting backlinks.",
        href: "/backlinks/link-building",
        endpoints: [
          "/v3/backlinks/competitors/live",
          "/v3/backlinks/domain_intersection/live",
          "/v3/backlinks/page_intersection/live",
        ],
      },
      {
        slug: "trends",
        category: "backlinks",
        label: "Backlink Trend Data",
        description:
          "Backlink history and new/lost link velocity over time.",
        href: "/backlinks/trends",
        endpoints: [
          "/v3/backlinks/history/live",
          "/v3/backlinks/timeseries_summary/live",
          "/v3/backlinks/timeseries_new_lost_summary/live",
        ],
      },
    ],
  },
  {
    slug: "technical",
    label: "Technical",
    icon: Globe,
    tools: [
      {
        slug: "onpage",
        category: "technical",
        label: "OnPage SEO Checker",
        description:
          "Site-wide audit: weighted health score, prioritized issues by severity, per-URL audit, Core Web Vitals, and schema validation.",
        href: "/technical/onpage",
        endpoints: [
          "/v3/on_page/task_post",
          "/v3/on_page/summary",
          "/v3/on_page/pages",
          "/v3/on_page/links",
          "/v3/on_page/duplicate_tags",
          "/v3/on_page/microdata",
          "/v3/on_page/redirect_chains",
          "/v3/on_page/non_indexable",
          "/v3/on_page/lighthouse/live/json",
        ],
      },
      {
        slug: "lighthouse",
        category: "technical",
        label: "Core Web Vitals + Lighthouse",
        description:
          "Lighthouse audit (performance, accessibility, best practices, SEO) for a URL.",
        href: "/technical/lighthouse",
        endpoints: [
          "/v3/on_page/lighthouse/live/json",
          "/v3/on_page/lighthouse/task_post",
        ],
      },
    ],
  },
  {
    slug: "competitive",
    label: "Analysis",
    icon: TrendingUp,
    tools: [
      {
        slug: "domain-overview",
        category: "competitive",
        label: "Domain Overview",
        description:
          "Visibility KPIs, position distribution, traffic trend, top keywords, competitors, backlink profile, and per-city SERP positions.",
        href: "/competitive/domain-overview",
        endpoints: [
          "/v3/dataforseo_labs/google/domain_rank_overview/live",
          "/v3/dataforseo_labs/google/historical_rank_overview/live",
          "/v3/backlinks/summary/live",
          "/v3/backlinks/timeseries_new_lost_summary/live",
          "/v3/dataforseo_labs/google/competitors_domain/live",
          "/v3/dataforseo_labs/google/ranked_keywords/live",
          "/v3/serp/google/organic/live/advanced",
        ],
      },
      {
        slug: "organic-rankings",
        category: "competitive",
        label: "Organic Rankings",
        description:
          "Visibility score, 12-month trend, movers, SERP features, intent breakdown, pages, keyword table, and per-city positions for a domain.",
        href: "/competitive/organic-rankings",
        endpoints: [
          "/v3/dataforseo_labs/google/ranked_keywords/live",
          "/v3/dataforseo_labs/google/historical_rank_overview/live",
          "/v3/dataforseo_labs/google/relevant_pages/live",
          "/v3/dataforseo_labs/google/search_intent/live",
          "/v3/serp/google/organic/live/advanced",
        ],
      },
    ],
  },
  {
    slug: "local",
    label: "Local",
    icon: MapPin,
    tools: [
      {
        slug: "gbp-heatmap",
        category: "local",
        label: "GBP Heatmap",
        description:
          "Geo-grid rank tracker for a business + keyword. Resolves the business via Google Business Profile, then runs a parallel Google Maps SERP scan across a 5×7 grid of vantage points and rolls the results up into rank KPIs and a competitor sidebar.",
        href: "/local/gbp-heatmap",
        endpoints: [
          "/v3/business_data/google/my_business_info/live",
          "/v3/serp/google/maps/live/advanced",
        ],
      },
    ],
  },
  {
    slug: "ai",
    label: "AI",
    icon: Bot,
    tools: [
      {
        slug: "snapshot",
        category: "ai",
        label: "AI Snapshot",
        description:
          "Live prospect dashboard: how often a brand surfaces in LLM responses and Google's AI Overview, who its AI-search competitors are, and what sources LLMs cite when answering category questions.",
        href: "/ai/snapshot",
        endpoints: [
          "/v3/ai_optimization/ai_keyword_data/keywords_search_volume/live",
          "/v3/ai_optimization/llm_mentions/aggregated_metrics/live",
          "/v3/ai_optimization/llm_mentions/cross_aggregated_metrics/live",
          "/v3/ai_optimization/llm_mentions/top_domains/live",
          "/v3/ai_optimization/llm_mentions/top_pages/live",
          "/v3/ai_optimization/llm_mentions/search/live",
          "/v3/ai_optimization/chat_gpt/llm_responses/live",
          "/v3/serp/google/organic/live/advanced",
        ],
      },
    ],
  },
  {
    slug: "other",
    label: "Other",
    icon: FolderOpen,
    tools: [
      {
        slug: "audit",
        category: "other",
        label: "Audit",
        description: "Pre-sales SEO audit PDF for a prospect domain.",
        href: "/audit",
        endpoints: [],
      },
      {
        slug: "scheduled-tasks",
        category: "other",
        label: "Scheduled Tasks",
        description: "Recurring SEO automation jobs and their run history.",
        href: "/scheduled-tasks",
        endpoints: [],
      },
    ],
  },
]

export const ALL_TOOLS: readonly Tool[] = TOOL_CATEGORIES.flatMap(
  (c) => c.tools,
)

export function findCategoryByPathname(
  pathname: string | null,
): ToolCategory | null {
  if (!pathname) return null
  for (const cat of TOOL_CATEGORIES) {
    for (const tool of cat.tools) {
      if (pathname === tool.href || pathname.startsWith(`${tool.href}/`)) {
        return cat
      }
    }
  }
  return null
}

export function findToolByPathname(pathname: string | null): Tool | null {
  if (!pathname) return null
  for (const cat of TOOL_CATEGORIES) {
    for (const tool of cat.tools) {
      if (pathname === tool.href || pathname.startsWith(`${tool.href}/`)) {
        return tool
      }
    }
  }
  return null
}
