import { z } from "zod"
import { runTool } from "@/lib/tool-route"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const Input = z.object({
  prompt: z.string().min(1),
  llm: z.enum(["chat_gpt", "claude", "gemini", "perplexity"]),
})

type Row = {
  llm: string
  prompt: string
  response_preview: string
  citation_count: number | null
}

const ENDPOINT_BY_LLM = {
  chat_gpt: "/v3/ai_optimization/chat_gpt/llm_responses/live",
  claude: "/v3/ai_optimization/claude/llm_responses/live",
  gemini: "/v3/ai_optimization/gemini/llm_responses/live",
  perplexity: "/v3/ai_optimization/perplexity/llm_responses/live",
} as const

export async function POST(request: Request) {
  return runTool<typeof Input, Row>(request, Input, async (input, { dfs }) => {
    const endpoint = ENDPOINT_BY_LLM[input.llm]
    const body = [{ user_prompt: input.prompt }]
    const env = (await dfs(endpoint, body, { timeoutMs: 180_000 })) as {
      cost?: number
      tasks?: { result?: unknown[] }[]
    }

    const rows: Row[] = []
    for (const task of env.tasks ?? []) {
      for (const r of task.result ?? []) {
        const it = r as {
          items?: {
            llm_response_text?: string | null
            citations?: { url?: string }[] | null
          }[]
        }
        for (const item of it.items ?? []) {
          const text = item.llm_response_text ?? ""
          rows.push({
            llm: input.llm,
            prompt: input.prompt,
            response_preview: text.slice(0, 300),
            citation_count: item.citations?.length ?? null,
          })
        }
      }
    }

    return {
      rows,
      endpoints: [endpoint],
      costUsd: env.cost,
    }
  })
}
