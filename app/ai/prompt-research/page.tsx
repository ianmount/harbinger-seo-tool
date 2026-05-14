"use client"

import { useState, type FormEvent } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  ResultsTable,
  type ResultColumn,
} from "@/components/tool/ResultsTable"
import { ToolShell } from "@/components/tool/ToolShell"
import {
  ToolError,
  ToolSection,
  useToolRun,
} from "@/components/tool/use-tool-run"
import { findToolByPathname } from "@/lib/tool-config"

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

const RESPONSE_COLS: ResultColumn<ResponseRow>[] = [
  { key: "llm", label: "LLM", accessor: (r) => r.llm },
  {
    key: "response_preview",
    label: "Response (first 400 chars)",
    accessor: (r) => r.response_preview,
  },
  {
    key: "citation_count",
    label: "Citations",
    numeric: true,
    accessor: (r) => r.citation_count,
  },
]

const SV_COLS: ResultColumn<SearchVolumeRow>[] = [
  { key: "keyword", label: "Keyword", accessor: (r) => r.keyword },
  {
    key: "ai_search_volume",
    label: "AI Search Volume",
    numeric: true,
    accessor: (r) => r.ai_search_volume,
    format: (r) =>
      r.ai_search_volume == null
        ? "—"
        : r.ai_search_volume.toLocaleString(),
  },
  { key: "source", label: "Source", accessor: (r) => r.source },
]

const MENTION_COLS: ResultColumn<MentionRow>[] = [
  {
    key: "llm",
    label: "LLM",
    accessor: (r) => r.llm,
    format: (r) => r.llm ?? "—",
  },
  {
    key: "prompt",
    label: "Original Prompt",
    accessor: (r) => r.prompt,
    format: (r) => r.prompt ?? "—",
  },
  {
    key: "brand_position",
    label: "Brand Pos.",
    numeric: true,
    accessor: (r) => r.brand_position,
  },
  {
    key: "total_brands_mentioned",
    label: "Total Brands",
    numeric: true,
    accessor: (r) => r.total_brands_mentioned,
  },
  {
    key: "date",
    label: "Date",
    accessor: (r) => r.date,
    format: (r) => (r.date ? r.date.slice(0, 10) : "—"),
  },
]

export default function PromptResearchPage() {
  const tool = findToolByPathname("/ai/prompt-research")!
  const [prompt, setPrompt] = useState("")
  const [keyword, setKeyword] = useState("")
  const { data, meta, loading, error, run, setError } = useToolRun<Data>(
    "/api/tools/ai/prompt-research",
  )

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!prompt.trim()) {
      setError("Enter a prompt.")
      return
    }
    await run({
      prompt: prompt.trim(),
      keyword: keyword.trim() || undefined,
    })
  }

  return (
    <ToolShell
      category="AI"
      title={tool.label}
      description={tool.description}
      endpoints={tool.endpoints}
      meta={meta}
      form={
        <form onSubmit={onSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="prompt">Prompt</Label>
            <Textarea
              id="prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Who are the best plumbers in Atlanta?"
              rows={4}
              disabled={loading}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_auto] md:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="keyword">
                Brand keyword (optional — defaults to the prompt itself)
              </Label>
              <Input
                id="keyword"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="acme plumbing"
                disabled={loading}
              />
            </div>
            <Button type="submit" disabled={loading}>
              {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Run All 4 LLMs
            </Button>
          </div>
        </form>
      }
      results={
        error ? (
          <ToolError message={error} />
        ) : (
          <>
            <ToolSection
              title="LLM Responses (ChatGPT / Claude / Gemini / Perplexity)"
              description="Each LLM's actual response to the prompt. ~$0.01 per LLM per run."
            >
              <ResultsTable
                rows={data?.responses ?? []}
                columns={RESPONSE_COLS}
                filename="ai-prompt-responses"
              />
            </ToolSection>
            <ToolSection title="AI Search Volume">
              <ResultsTable
                rows={data?.aiSearchVolume ?? []}
                columns={SV_COLS}
                filename="ai-search-volume"
              />
            </ToolSection>
            <ToolSection title="Existing LLM Mentions (historical)">
              <ResultsTable
                rows={data?.existingMentions ?? []}
                columns={MENTION_COLS}
                filename="ai-existing-mentions"
              />
            </ToolSection>
          </>
        )
      }
    />
  )
}
