import { z } from "zod"
import { dfsCost, dfsItems, runTool } from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const Input = z.object({
  prompt: z.string().min(1),
  /** Optional brand/keyword to mine for mentions + AI search volume. Defaults to the prompt itself. */
  keyword: z.string().optional(),
})

type ResponseRow = {
  llm: string
  prompt: string
  response_preview: string
  full_response: string
  citation_count: number | null
}

type SearchVolumeRow = {
  keyword: string
  ai_search_volume: number | null
  source: string
}

type MentionRow = {
  llm: string | null
  prompt: string | null
  brand_position: number | null
  total_brands_mentioned: number | null
  date: string | null
}

type Data = {
  responses: ResponseRow[]
  aiSearchVolume: SearchVolumeRow[]
  existingMentions: MentionRow[]
}

const LLM_ENDPOINTS = [
  ["chat_gpt", "/v3/ai_optimization/chat_gpt/llm_responses/live"],
  ["claude", "/v3/ai_optimization/claude/llm_responses/live"],
  ["gemini", "/v3/ai_optimization/gemini/llm_responses/live"],
  ["perplexity", "/v3/ai_optimization/perplexity/llm_responses/live"],
] as const

export async function POST(request: Request) {
  return runTool<typeof Input, Data>(request, Input, async (input, { dfs }) => {
    const keyword = (input.keyword ?? input.prompt).trim()

    // Fire all 4 LLM response endpoints + 2 metadata endpoints in parallel.
    const promises = [
      ...LLM_ENDPOINTS.map(([, endpoint]) =>
        dfs(endpoint, [{ user_prompt: input.prompt }], {
          timeoutMs: 240_000,
        }).catch(() => null),
      ),
      dfs(
        "/v3/ai_optimization/ai_keyword_data/keywords_search_volume/live",
        [{ keywords: [keyword] }],
      ).catch(() => null),
      dfs("/v3/ai_optimization/llm_mentions/search/live", [
        { keyword, limit: 50 },
      ]).catch(() => null),
    ]

    const settled = await Promise.all(promises)
    const llmEnvs = settled.slice(0, LLM_ENDPOINTS.length)
    const aiSvEnv = settled[LLM_ENDPOINTS.length]
    const mentionsEnv = settled[LLM_ENDPOINTS.length + 1]

    const responses: ResponseRow[] = []
    LLM_ENDPOINTS.forEach(([llmKey], i) => {
      const env = llmEnvs[i]
      if (!env) return
      for (const task of (env as { tasks?: { result?: unknown[] }[] }).tasks ??
        []) {
        for (const r of task.result ?? []) {
          const it = r as {
            items?: {
              llm_response_text?: string | null
              citations?: { url?: string }[] | null
            }[]
          }
          for (const item of it.items ?? []) {
            const text = item.llm_response_text ?? ""
            responses.push({
              llm: llmKey,
              prompt: input.prompt,
              response_preview: text.slice(0, 400),
              full_response: text,
              citation_count: item.citations?.length ?? null,
            })
          }
        }
      }
    })

    const aiSearchVolume: SearchVolumeRow[] = aiSvEnv
      ? dfsItems<{
          keyword?: string
          ai_search_volume?: number | null
          search_volume?: number | null
          source?: string | null
        }>(aiSvEnv).map((it) => ({
          keyword: it.keyword ?? keyword,
          ai_search_volume: it.ai_search_volume ?? it.search_volume ?? null,
          source: it.source ?? "AI search",
        }))
      : []

    const existingMentions: MentionRow[] = mentionsEnv
      ? dfsItems<{
          llm_provider?: string | null
          llm_model?: string | null
          prompt?: string | null
          brand_position?: number | null
          total_brands_mentioned?: number | null
          date?: string | null
        }>(mentionsEnv).map((it) => ({
          llm: it.llm_model ?? it.llm_provider ?? null,
          prompt: it.prompt ?? null,
          brand_position: it.brand_position ?? null,
          total_brands_mentioned: it.total_brands_mentioned ?? null,
          date: it.date ?? null,
        }))
      : []

    return {
      data: { responses, aiSearchVolume, existingMentions },
      endpoints: [
        "/v3/ai_optimization/ai_keyword_data/keywords_search_volume/live",
        "/v3/ai_optimization/llm_mentions/search/live",
        ...LLM_ENDPOINTS.map(([, e]) => e),
      ],
      costUsd: dfsCost(...llmEnvs, aiSvEnv, mentionsEnv),
    }
  })
}
