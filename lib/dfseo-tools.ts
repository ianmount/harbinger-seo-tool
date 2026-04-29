/**
 * Specs for the "DataForSEO APIs" tool tab.
 *
 * Each spec describes a single live DataForSEO endpoint: the form fields the
 * user fills in, the underlying DFS endpoint path, and whether the output is
 * rendered as a Markdown report or a CSV table. Both the client form and the
 * server-side runner read these specs, so the source of truth for endpoint
 * shape lives in one place.
 *
 * OnPage crawl workflow (task_post / summary / pages / etc.) is intentionally
 * out of scope here — those endpoints are async and would need polling. This
 * tab only covers live (synchronous) endpoints.
 */

export type ToolFieldKind =
  | "text"
  | "textarea"
  | "number"
  | "boolean"
  | "select"
  | "string-array"
  | "location"

export type ToolFieldOption = { value: string; label: string }

export type ToolField = {
  name: string
  label: string
  kind: ToolFieldKind
  required?: boolean
  default?: string | number | boolean | string[]
  placeholder?: string
  help?: string
  options?: ToolFieldOption[]
  min?: number
  max?: number
  /** For string-array fields. */
  maxItems?: number
}

export type ToolOutput = "csv" | "md"

export type ToolSpec = {
  id: string
  category: string
  label: string
  description: string
  endpoint: string
  output: ToolOutput
  fields: ToolField[]
}

const TARGET_FIELD: ToolField = {
  name: "target",
  label: "Target",
  kind: "text",
  required: true,
  placeholder: "example.com",
  help: "Domain or full URL.",
}

const LOCATION_FIELD: ToolField = {
  name: "location_code",
  label: "Location",
  kind: "location",
  required: true,
  default: 2840,
  help: "DataForSEO Google Ads location code. 2840 = United States. Search to pick a city, state, or country.",
}

const LANGUAGE_FIELD: ToolField = {
  name: "language_code",
  label: "Language",
  kind: "text",
  required: true,
  default: "en",
  help: "ISO language code (e.g. \"en\").",
}

const LIMIT_FIELD = (max: number, def: number): ToolField => ({
  name: "limit",
  label: "Limit",
  kind: "number",
  default: def,
  min: 1,
  max,
  help: `Max rows returned. 1–${max}.`,
})

const BACKLINKS_STATUS_FIELD: ToolField = {
  name: "backlinks_status_type",
  label: "Status",
  kind: "select",
  default: "live",
  options: [
    { value: "live", label: "Live (current backlinks)" },
    { value: "all", label: "All (including lost)" },
  ],
}

export const TOOL_SPECS: ToolSpec[] = [
  // ── Backlinks ───────────────────────────────────────────────────────────
  {
    id: "backlinks-summary",
    category: "Backlinks",
    label: "Backlinks Summary",
    endpoint: "/v3/backlinks/summary/live",
    description:
      "Top-level backlink counts for a domain (referring domains, backlinks, broken pages, etc.).",
    output: "md",
    fields: [
      TARGET_FIELD,
      {
        name: "internal_list_limit",
        label: "Internal list limit",
        kind: "number",
        default: 10,
        min: 1,
        max: 1000,
      },
      BACKLINKS_STATUS_FIELD,
    ],
  },
  {
    id: "backlinks-list",
    category: "Backlinks",
    label: "Backlinks List",
    endpoint: "/v3/backlinks/backlinks/live",
    description:
      "Individual backlinks linking to a domain. Use mode=one_per_domain for quality assessment.",
    output: "csv",
    fields: [
      TARGET_FIELD,
      LIMIT_FIELD(1000, 100),
      {
        name: "mode",
        label: "Mode",
        kind: "select",
        default: "as_is",
        options: [
          { value: "as_is", label: "As-is (every backlink)" },
          { value: "one_per_domain", label: "One per domain" },
          { value: "one_per_anchor", label: "One per anchor" },
        ],
      },
      BACKLINKS_STATUS_FIELD,
    ],
  },
  {
    id: "referring-domains",
    category: "Backlinks",
    label: "Referring Domains",
    endpoint: "/v3/backlinks/referring_domains/live",
    description: "Distinct domains linking to a target.",
    output: "csv",
    fields: [TARGET_FIELD, LIMIT_FIELD(1000, 100), BACKLINKS_STATUS_FIELD],
  },
  {
    id: "backlinks-anchors",
    category: "Backlinks",
    label: "Anchor Text Distribution",
    endpoint: "/v3/backlinks/anchors/live",
    description: "Anchor text variations and counts.",
    output: "csv",
    fields: [TARGET_FIELD, LIMIT_FIELD(1000, 100), BACKLINKS_STATUS_FIELD],
  },
  // ── DataForSEO Labs ─────────────────────────────────────────────────────
  {
    id: "labs-keyword-ideas",
    category: "Labs",
    label: "Keyword Ideas",
    endpoint: "/v3/dataforseo_labs/google/keyword_ideas/live",
    description: "Semantically related keywords for a small list of seeds.",
    output: "csv",
    fields: [
      {
        name: "keywords",
        label: "Seed keywords",
        kind: "string-array",
        required: true,
        placeholder: "roof repair\nemergency roofing",
        help: "Comma or newline separated. Max 200.",
        maxItems: 200,
      },
      LOCATION_FIELD,
      LANGUAGE_FIELD,
      LIMIT_FIELD(1000, 200),
    ],
  },
  {
    id: "labs-keyword-suggestions",
    category: "Labs",
    label: "Keyword Suggestions",
    endpoint: "/v3/dataforseo_labs/google/keyword_suggestions/live",
    description:
      "Long-tail queries containing the seed keyword as a substring.",
    output: "csv",
    fields: [
      {
        name: "keyword",
        label: "Seed keyword",
        kind: "text",
        required: true,
        placeholder: "roof repair",
      },
      LOCATION_FIELD,
      LANGUAGE_FIELD,
      LIMIT_FIELD(1000, 200),
    ],
  },
  {
    id: "labs-keyword-overview",
    category: "Labs",
    label: "Keyword Overview",
    endpoint: "/v3/dataforseo_labs/google/keyword_overview/live",
    description: "Detailed metrics for a list of specific keywords.",
    output: "csv",
    fields: [
      {
        name: "keywords",
        label: "Keywords",
        kind: "string-array",
        required: true,
        placeholder: "roof repair\nroofing contractor",
        maxItems: 700,
      },
      LOCATION_FIELD,
      LANGUAGE_FIELD,
    ],
  },
  {
    id: "labs-ranked-keywords",
    category: "Labs",
    label: "Ranked Keywords",
    endpoint: "/v3/dataforseo_labs/google/ranked_keywords/live",
    description: "All keywords a domain currently ranks for.",
    output: "csv",
    fields: [
      TARGET_FIELD,
      LOCATION_FIELD,
      LANGUAGE_FIELD,
      LIMIT_FIELD(1000, 200),
      {
        name: "max_rank",
        label: "Max rank",
        kind: "number",
        default: 100,
        min: 1,
        max: 100,
        help: "Cap by SERP rank — passed as a filter on rank_absolute.",
      },
    ],
  },
  {
    id: "labs-serp-competitors",
    category: "Labs",
    label: "SERP Competitors",
    endpoint: "/v3/dataforseo_labs/google/serp_competitors/live",
    description: "Domains that consistently rank for a keyword set.",
    output: "csv",
    fields: [
      {
        name: "keywords",
        label: "Keywords",
        kind: "string-array",
        required: true,
        placeholder: "roof repair denver\nroofing contractor denver",
        maxItems: 200,
      },
      LOCATION_FIELD,
      LANGUAGE_FIELD,
      LIMIT_FIELD(1000, 100),
    ],
  },
  // ── Keyword Data ────────────────────────────────────────────────────────
  {
    id: "kwdata-search-volume",
    category: "Keyword Data",
    label: "Google Ads Search Volume",
    endpoint: "/v3/keywords_data/google_ads/search_volume/live",
    description: "Monthly search volume from Google Keyword Planner.",
    output: "csv",
    fields: [
      {
        name: "keywords",
        label: "Keywords",
        kind: "string-array",
        required: true,
        placeholder: "roof repair\nroofing contractor",
        maxItems: 1000,
      },
      LOCATION_FIELD,
      LANGUAGE_FIELD,
      {
        name: "search_partners",
        label: "Include search partner network",
        kind: "boolean",
        default: false,
      },
    ],
  },
  {
    id: "kwdata-google-trends",
    category: "Keyword Data",
    label: "Google Trends Explore",
    endpoint: "/v3/keywords_data/google_trends/explore/live",
    description: "Relative search interest timeseries (max 5 keywords).",
    output: "csv",
    fields: [
      {
        name: "keywords",
        label: "Keywords",
        kind: "string-array",
        required: true,
        placeholder: "roof repair\nroof replacement",
        maxItems: 5,
      },
      LOCATION_FIELD,
      {
        name: "time_range",
        label: "Time range",
        kind: "select",
        default: "past_12_months",
        options: [
          { value: "past_4_hours", label: "Past 4 hours" },
          { value: "past_day", label: "Past day" },
          { value: "past_7_days", label: "Past 7 days" },
          { value: "past_30_days", label: "Past 30 days" },
          { value: "past_90_days", label: "Past 90 days" },
          { value: "past_12_months", label: "Past 12 months" },
          { value: "past_5_years", label: "Past 5 years" },
          { value: "all_time", label: "All time" },
        ],
      },
      {
        name: "type",
        label: "Type",
        kind: "select",
        default: "web",
        options: [
          { value: "web", label: "Web search" },
          { value: "news", label: "News" },
          { value: "images", label: "Images" },
          { value: "youtube", label: "YouTube" },
          { value: "froogle", label: "Shopping" },
        ],
      },
    ],
  },
  {
    id: "kwdata-dfs-trends",
    category: "Keyword Data",
    label: "DataForSEO Trends Explore",
    endpoint: "/v3/keywords_data/dataforseo_trends/explore/live",
    description:
      "DataForSEO's clickstream-derived trends (alternate to Google Trends).",
    output: "csv",
    fields: [
      {
        name: "keywords",
        label: "Keywords",
        kind: "string-array",
        required: true,
        placeholder: "roof repair\nroof replacement",
        maxItems: 5,
      },
      LOCATION_FIELD,
    ],
  },
  // ── SERP ────────────────────────────────────────────────────────────────
  {
    id: "serp-google-organic",
    category: "SERP",
    label: "Google Organic SERP",
    endpoint: "/v3/serp/google/organic/live/advanced",
    description: "Live Google SERP elements for one keyword.",
    output: "csv",
    fields: [
      {
        name: "keyword",
        label: "Keyword",
        kind: "text",
        required: true,
        placeholder: "roof repair denver",
      },
      LOCATION_FIELD,
      LANGUAGE_FIELD,
      {
        name: "depth",
        label: "Depth",
        kind: "number",
        default: 100,
        min: 10,
        max: 700,
        help: "Number of organic results to fetch (10–700).",
      },
      {
        name: "device",
        label: "Device",
        kind: "select",
        default: "desktop",
        options: [
          { value: "desktop", label: "Desktop" },
          { value: "mobile", label: "Mobile" },
        ],
      },
    ],
  },
  {
    id: "serp-youtube-organic",
    category: "SERP",
    label: "YouTube Organic SERP",
    endpoint: "/v3/serp/youtube/organic/live/advanced",
    description: "Top YouTube search results for a query.",
    output: "csv",
    fields: [
      {
        name: "keyword",
        label: "Query",
        kind: "text",
        required: true,
        placeholder: "how to repair a roof",
      },
      LOCATION_FIELD,
      LANGUAGE_FIELD,
    ],
  },
  {
    id: "serp-youtube-video-info",
    category: "SERP",
    label: "YouTube Video Info",
    endpoint: "/v3/serp/youtube/video_info/live/advanced",
    description: "Detailed metadata for a single YouTube video.",
    output: "md",
    fields: [
      {
        name: "video_id",
        label: "Video ID or URL",
        kind: "text",
        required: true,
        placeholder: "dQw4w9WgXcQ or https://youtu.be/dQw4w9WgXcQ",
        help: "Full URL is fine — the ID is extracted automatically.",
      },
      LOCATION_FIELD,
    ],
  },
  // ── OnPage (live single-page only — crawl workflow excluded) ────────────
  {
    id: "onpage-instant",
    category: "OnPage",
    label: "Instant Page Audit",
    endpoint: "/v3/on_page/instant_pages",
    description:
      "Full on-page audit of one URL — meta tags, content stats, detected issues.",
    output: "md",
    fields: [
      {
        name: "url",
        label: "URL",
        kind: "text",
        required: true,
        placeholder: "https://example.com/services/roof-repair/",
        help: "Full URL with protocol.",
      },
      {
        name: "enable_javascript",
        label: "Render JavaScript",
        kind: "boolean",
        default: false,
        help: "Enable for client-rendered sites.",
      },
      {
        name: "load_resources",
        label: "Load resources",
        kind: "boolean",
        default: false,
        help: "Fetch CSS/JS/images for accurate page-weight metrics.",
      },
    ],
  },
  {
    id: "onpage-lighthouse",
    category: "OnPage",
    label: "Lighthouse Audit",
    endpoint: "/v3/on_page/lighthouse/live/json",
    description: "Google Lighthouse scores and audits.",
    output: "md",
    fields: [
      {
        name: "url",
        label: "URL",
        kind: "text",
        required: true,
        placeholder: "https://example.com/",
      },
      {
        name: "for_mobile",
        label: "Mobile audit",
        kind: "boolean",
        default: true,
        help: "Recommended on for mobile-first indexing.",
      },
    ],
  },
  {
    id: "onpage-content-parsing",
    category: "OnPage",
    label: "Content Parsing",
    endpoint: "/v3/on_page/content_parsing/live",
    description: "Structured page content — headings, sections, paragraphs.",
    output: "md",
    fields: [
      {
        name: "url",
        label: "URL",
        kind: "text",
        required: true,
        placeholder: "https://example.com/blog/article/",
      },
      {
        name: "enable_javascript",
        label: "Render JavaScript",
        kind: "boolean",
        default: false,
      },
    ],
  },
  // ── AI Optimization ─────────────────────────────────────────────────────
  {
    id: "ai-keyword-volume",
    category: "AI Optimization",
    label: "AI Keyword Search Volume",
    endpoint:
      "/v3/ai_optimization/ai_keyword_data/keywords_search_volume/live",
    description:
      "Estimated AI search volume (ChatGPT etc.) per keyword with 12-month trend.",
    output: "csv",
    fields: [
      {
        name: "keywords",
        label: "Keywords",
        kind: "string-array",
        required: true,
        maxItems: 1000,
        placeholder: "roof repair\nemergency roofing",
      },
      LOCATION_FIELD,
      LANGUAGE_FIELD,
    ],
  },
  {
    id: "ai-llm-mentions-search",
    category: "AI Optimization",
    label: "LLM Mentions Search",
    endpoint: "/v3/ai_optimization/llm_mentions/search/live",
    description: "Mentions of a keyword or domain in AI responses.",
    output: "csv",
    fields: [
      {
        name: "target_kind",
        label: "Target type",
        kind: "select",
        default: "keyword",
        options: [
          { value: "keyword", label: "Keyword" },
          { value: "domain", label: "Domain" },
        ],
      },
      {
        name: "target_value",
        label: "Target value",
        kind: "text",
        required: true,
        placeholder: "roof repair denver",
      },
      {
        name: "search_scope",
        label: "Search scope",
        kind: "select",
        default: "any",
        options: [
          { value: "any", label: "Any (default)" },
          { value: "answer", label: "Answer only" },
          { value: "question", label: "Question only" },
          { value: "sources", label: "Sources only" },
        ],
      },
      {
        name: "platform",
        label: "Platform",
        kind: "select",
        default: "google",
        options: [
          { value: "google", label: "Google AI Overviews" },
          { value: "chat_gpt", label: "ChatGPT" },
        ],
      },
      LOCATION_FIELD,
      LANGUAGE_FIELD,
      LIMIT_FIELD(100, 20),
    ],
  },
  {
    id: "ai-llm-mentions-aggregated",
    category: "AI Optimization",
    label: "LLM Mentions Aggregated Metrics",
    endpoint: "/v3/ai_optimization/llm_mentions/aggregated_metrics/live",
    description:
      "Summary stats grouped by location, language, platform, and source domain.",
    output: "md",
    fields: [
      {
        name: "target_kind",
        label: "Target type",
        kind: "select",
        default: "keyword",
        options: [
          { value: "keyword", label: "Keyword" },
          { value: "domain", label: "Domain" },
        ],
      },
      {
        name: "target_value",
        label: "Target value",
        kind: "text",
        required: true,
        placeholder: "roof repair",
      },
      {
        name: "search_scope",
        label: "Search scope",
        kind: "select",
        default: "any",
        options: [
          { value: "any", label: "Any" },
          { value: "answer", label: "Answer" },
          { value: "question", label: "Question" },
          { value: "sources", label: "Sources" },
        ],
      },
      {
        name: "platform",
        label: "Platform",
        kind: "select",
        default: "google",
        options: [
          { value: "google", label: "Google AI Overviews" },
          { value: "chat_gpt", label: "ChatGPT" },
        ],
      },
      LOCATION_FIELD,
      LANGUAGE_FIELD,
    ],
  },
  {
    id: "ai-chatgpt-scraper",
    category: "AI Optimization",
    label: "ChatGPT Scraper",
    endpoint: "/v3/ai_optimization/chat_gpt/llm_scraper/live/advanced",
    description:
      "Live ChatGPT response a real user would see, with cited sources.",
    output: "md",
    fields: [
      {
        name: "keyword",
        label: "Query",
        kind: "text",
        required: true,
        placeholder: "best roofing contractors in denver",
      },
      LOCATION_FIELD,
      LANGUAGE_FIELD,
      {
        name: "force_web_search",
        label: "Force web search",
        kind: "boolean",
        default: true,
      },
    ],
  },
  // LLM Responses (4 platforms) — same shape, different endpoint + default model.
  {
    id: "ai-llm-chatgpt",
    category: "AI Optimization",
    label: "ChatGPT Response",
    endpoint: "/v3/ai_optimization/chat_gpt/llm_responses/live",
    description: "ChatGPT response to a prompt.",
    output: "md",
    fields: llmResponseFields("gpt-4.1-mini"),
  },
  {
    id: "ai-llm-claude",
    category: "AI Optimization",
    label: "Claude Response",
    endpoint: "/v3/ai_optimization/claude/llm_responses/live",
    description: "Claude response to a prompt.",
    output: "md",
    fields: llmResponseFields("claude-sonnet-4-0"),
  },
  {
    id: "ai-llm-gemini",
    category: "AI Optimization",
    label: "Gemini Response",
    endpoint: "/v3/ai_optimization/gemini/llm_responses/live",
    description: "Gemini response to a prompt.",
    output: "md",
    fields: llmResponseFields("gemini-2.5-flash"),
  },
  {
    id: "ai-llm-perplexity",
    category: "AI Optimization",
    label: "Perplexity Response",
    endpoint: "/v3/ai_optimization/perplexity/llm_responses/live",
    description: "Perplexity (sonar) response to a prompt.",
    output: "md",
    fields: llmResponseFields("sonar"),
  },
]

function llmResponseFields(defaultModel: string): ToolField[] {
  return [
    {
      name: "user_prompt",
      label: "User prompt",
      kind: "textarea",
      required: true,
      placeholder: "What are reputable roofing contractors in Denver, CO?",
      max: 500,
      help: "Max 500 characters.",
    },
    {
      name: "model_name",
      label: "Model",
      kind: "text",
      default: defaultModel,
      help: "Override the default model name if needed.",
    },
    {
      name: "system_message",
      label: "System message",
      kind: "textarea",
      max: 500,
      help: "Optional system prompt. Max 500 characters.",
    },
    {
      name: "max_output_tokens",
      label: "Max output tokens",
      kind: "number",
      default: 1024,
      min: 16,
      max: 4096,
    },
    {
      name: "temperature",
      label: "Temperature",
      kind: "number",
      default: 0.3,
      min: 0,
      max: 2,
    },
    {
      name: "web_search",
      label: "Enable web search",
      kind: "boolean",
      default: false,
      help: "Always on for Perplexity sonar models.",
    },
    {
      name: "web_search_country_iso_code",
      label: "Web search country (ISO-2)",
      kind: "text",
      placeholder: "US",
      help: "Optional. 2-letter ISO country code.",
    },
  ]
}

export function getToolSpec(id: string): ToolSpec | undefined {
  return TOOL_SPECS.find((t) => t.id === id)
}

export function groupedToolSpecs(): { category: string; tools: ToolSpec[] }[] {
  const groups = new Map<string, ToolSpec[]>()
  for (const spec of TOOL_SPECS) {
    const existing = groups.get(spec.category) ?? []
    existing.push(spec)
    groups.set(spec.category, existing)
  }
  return Array.from(groups.entries()).map(([category, tools]) => ({
    category,
    tools,
  }))
}
