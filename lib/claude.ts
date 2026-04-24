import "server-only"
import Anthropic from "@anthropic-ai/sdk"
import { requireEnv } from "@/lib/env"

export const DEFAULT_MODEL = "claude-opus-4-7"
export const DEFAULT_MAX_TOKENS = 4096

export interface CallClaudeOptions {
  model?: string
  maxTokens?: number
  system?: string
}

export class ClaudeApiError extends Error {
  readonly status: number | undefined
  constructor(message: string, status: number | undefined) {
    super(message)
    this.name = "ClaudeApiError"
    this.status = status
  }
}

let cachedClient: Anthropic | null = null

function getClient(): Anthropic {
  if (cachedClient) return cachedClient
  cachedClient = new Anthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY") })
  return cachedClient
}

export async function callClaude(
  prompt: string,
  opts: CallClaudeOptions = {},
): Promise<string> {
  const model = opts.model ?? DEFAULT_MODEL
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS
  const client = getClient()

  // Always stream. The Anthropic SDK enforces streaming for operations that
  // may take longer than 10 minutes (long input, long output, or high
  // max_tokens). Clustering 300 keywords with max_tokens=32000 consistently
  // trips this guard on non-streamed calls. We don't need the incremental
  // events — finalMessage() awaits the full response.
  let response: Anthropic.Message
  try {
    const stream = client.messages.stream({
      model,
      max_tokens: maxTokens,
      system: opts.system,
      messages: [{ role: "user", content: prompt }],
    })
    response = await stream.finalMessage()
  } catch (error: unknown) {
    if (error instanceof Anthropic.APIError) {
      throw new ClaudeApiError(
        `Anthropic API error (${error.status ?? "no status"}): ${error.message}`,
        error.status,
      )
    }
    throw error
  }

  const { input_tokens, output_tokens } = response.usage
  console.log(
    `[claude] model=${model} input_tokens=${input_tokens} output_tokens=${output_tokens} stop_reason=${response.stop_reason}`,
  )

  const textBlocks = response.content.filter(
    (block): block is Anthropic.TextBlock => block.type === "text",
  )
  if (textBlocks.length === 0) {
    throw new ClaudeApiError(
      `Anthropic returned no text content (stop_reason=${response.stop_reason})`,
      undefined,
    )
  }
  return textBlocks.map((b) => b.text).join("")
}
