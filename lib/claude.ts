import "server-only"
import Anthropic from "@anthropic-ai/sdk"
import { recordClaudeCost } from "@/lib/audit-cost"
import { requireEnv } from "@/lib/env"

export const DEFAULT_MODEL = "claude-opus-4-7"
export const DEFAULT_MAX_TOKENS = 4096

/**
 * Published Anthropic pricing for Claude Opus (per 1M tokens). These are
 * used by callers that want to surface an estimated cost in the UI — the
 * number is an approximation, not a billing reconciliation. Update if
 * Anthropic changes the published rates.
 */
export const OPUS_INPUT_PRICE_PER_MTOK = 15
export const OPUS_OUTPUT_PRICE_PER_MTOK = 75

export interface CallClaudeOptions {
  model?: string
  maxTokens?: number
  system?: string
}

export interface ClaudeUsage {
  input_tokens: number
  output_tokens: number
}

export interface ClaudeResult {
  text: string
  usage: ClaudeUsage
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

export async function callClaudeDetailed(
  prompt: string,
  opts: CallClaudeOptions = {},
): Promise<ClaudeResult> {
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
  recordClaudeCost({ inputTokens: input_tokens, outputTokens: output_tokens })
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
  return {
    text: textBlocks.map((b) => b.text).join(""),
    usage: { input_tokens, output_tokens },
  }
}

export async function callClaude(
  prompt: string,
  opts: CallClaudeOptions = {},
): Promise<string> {
  const { text } = await callClaudeDetailed(prompt, opts)
  return text
}
