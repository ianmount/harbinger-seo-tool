"use client"

import { useState, type FormEvent } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import {
  ResultsTable,
  type ResultColumn,
} from "@/components/tool/ResultsTable"
import { ToolShell } from "@/components/tool/ToolShell"
import { ToolError, useToolRun } from "@/components/tool/use-tool-run"
import { findToolByPathname } from "@/lib/tool-config"

type Row = {
  llm: string
  prompt: string
  response_preview: string
  citation_count: number | null
}

const COLUMNS: ResultColumn<Row>[] = [
  { key: "llm", label: "LLM", accessor: (r) => r.llm },
  { key: "prompt", label: "Prompt", accessor: (r) => r.prompt },
  {
    key: "response_preview",
    label: "Response (first 300 chars)",
    accessor: (r) => r.response_preview,
  },
  {
    key: "citation_count",
    label: "Citations",
    numeric: true,
    accessor: (r) => r.citation_count,
  },
]

export default function PromptResearchPage() {
  const tool = findToolByPathname("/ai/prompt-research")!
  const [prompt, setPrompt] = useState("")
  const [llm, setLlm] = useState<"chat_gpt" | "claude" | "gemini" | "perplexity">(
    "chat_gpt",
  )
  const { rows, loading, error, run, setError } = useToolRun<Row>(
    "/api/tools/ai/prompt-research",
  )

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!prompt.trim()) {
      setError("Enter a prompt.")
      return
    }
    await run({ prompt: prompt.trim(), llm })
  }

  return (
    <ToolShell
      category="AI"
      title={tool.label}
      description={tool.description}
      endpoints={tool.endpoints}
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
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-[200px] space-y-1.5">
              <Label>LLM</Label>
              <Select
                value={llm}
                onValueChange={(v) =>
                  setLlm(v as "chat_gpt" | "claude" | "gemini" | "perplexity")
                }
                disabled={loading}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="chat_gpt">ChatGPT</SelectItem>
                  <SelectItem value="claude">Claude</SelectItem>
                  <SelectItem value="gemini">Gemini</SelectItem>
                  <SelectItem value="perplexity">Perplexity</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={loading}>
              {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Run Prompt
            </Button>
          </div>
        </form>
      }
      results={
        error ? (
          <ToolError message={error} />
        ) : (
          <ResultsTable rows={rows} columns={COLUMNS} filename="ai-prompt-research" />
        )
      }
    />
  )
}
