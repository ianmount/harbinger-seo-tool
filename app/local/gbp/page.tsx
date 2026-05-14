"use client"

import { useState, type FormEvent } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { MarketPicker } from "@/components/tool/MarketPicker"
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
import type { DfsLabsLocation } from "@/lib/types"

type BusinessRow = {
  title: string
  category: string | null
  rating: number | null
  rating_count: number | null
  address: string | null
  phone: string | null
  url: string | null
  place_id: string | null
}

type ReviewRow = {
  source: string
  profile_name: string | null
  rating: number | null
  review_text: string | null
  timestamp: string | null
}

type QaRow = {
  question: string
  answers_count: number | null
  asker_name: string | null
  top_answer: string | null
}

type ListingRow = {
  title: string
  description: string | null
  category: string | null
  rating: number | null
  rating_count: number | null
  address: string | null
}

type Data = {
  business: BusinessRow[]
  reviews: ReviewRow[]
  extendedReviews: ReviewRow[]
  qa: QaRow[]
  listings: ListingRow[]
  reviewsStatus: string
}

const BUSINESS_COLS: ResultColumn<BusinessRow>[] = [
  { key: "title", label: "Business", accessor: (r) => r.title },
  {
    key: "category",
    label: "Category",
    accessor: (r) => r.category,
    format: (r) => r.category ?? "—",
  },
  {
    key: "rating",
    label: "Rating",
    numeric: true,
    accessor: (r) => r.rating,
    format: (r) => (r.rating == null ? "—" : r.rating.toFixed(1)),
  },
  {
    key: "rating_count",
    label: "Reviews",
    numeric: true,
    accessor: (r) => r.rating_count,
  },
  {
    key: "address",
    label: "Address",
    accessor: (r) => r.address,
    format: (r) => r.address ?? "—",
  },
  {
    key: "phone",
    label: "Phone",
    accessor: (r) => r.phone,
    format: (r) => r.phone ?? "—",
  },
  {
    key: "place_id",
    label: "Place ID",
    accessor: (r) => r.place_id,
    format: (r) => r.place_id ?? "—",
  },
]

const REVIEW_COLS: ResultColumn<ReviewRow>[] = [
  { key: "source", label: "Source", accessor: (r) => r.source },
  {
    key: "profile_name",
    label: "Reviewer",
    accessor: (r) => r.profile_name,
    format: (r) => r.profile_name ?? "—",
  },
  {
    key: "rating",
    label: "Rating",
    numeric: true,
    accessor: (r) => r.rating,
  },
  {
    key: "review_text",
    label: "Review",
    accessor: (r) => r.review_text,
    format: (r) => r.review_text ?? "—",
  },
  {
    key: "timestamp",
    label: "Date",
    accessor: (r) => r.timestamp,
    format: (r) => (r.timestamp ? r.timestamp.slice(0, 10) : "—"),
  },
]

const QA_COLS: ResultColumn<QaRow>[] = [
  { key: "question", label: "Question", accessor: (r) => r.question },
  {
    key: "answers_count",
    label: "Answers",
    numeric: true,
    accessor: (r) => r.answers_count,
  },
  {
    key: "asker_name",
    label: "Asker",
    accessor: (r) => r.asker_name,
    format: (r) => r.asker_name ?? "—",
  },
  {
    key: "top_answer",
    label: "Top Answer",
    accessor: (r) => r.top_answer,
    format: (r) => r.top_answer ?? "—",
  },
]

const LISTING_COLS: ResultColumn<ListingRow>[] = [
  { key: "title", label: "Business", accessor: (r) => r.title },
  {
    key: "category",
    label: "Category",
    accessor: (r) => r.category,
    format: (r) => r.category ?? "—",
  },
  {
    key: "rating",
    label: "Rating",
    numeric: true,
    accessor: (r) => r.rating,
    format: (r) => (r.rating == null ? "—" : r.rating.toFixed(1)),
  },
  {
    key: "rating_count",
    label: "Reviews",
    numeric: true,
    accessor: (r) => r.rating_count,
  },
  {
    key: "address",
    label: "Address",
    accessor: (r) => r.address,
    format: (r) => r.address ?? "—",
  },
  {
    key: "description",
    label: "Description",
    accessor: (r) => r.description,
    format: (r) => r.description ?? "—",
  },
]

export default function GbpPage() {
  const tool = findToolByPathname("/local/gbp")!
  const [keyword, setKeyword] = useState("")
  const [market, setMarket] = useState<DfsLabsLocation | null>(null)
  const { data, meta, loading, error, run, setError } = useToolRun<Data>(
    "/api/tools/local/gbp",
  )

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!keyword.trim()) {
      setError("Enter a business search keyword.")
      return
    }
    await run({
      keyword: keyword.trim(),
      location_code: market?.location_code,
      location_name: market ? undefined : "United States",
    })
  }

  return (
    <ToolShell
      category="Local"
      title={tool.label}
      description={tool.description}
      endpoints={tool.endpoints}
      meta={meta}
      form={
        <form
          onSubmit={onSubmit}
          className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_280px_auto] md:items-end"
        >
          <div className="space-y-1.5">
            <Label htmlFor="keyword">Business search</Label>
            <Input
              id="keyword"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="plumber atlanta"
              disabled={loading}
            />
          </div>
          <MarketPicker value={market} onChange={setMarket} />
          <Button type="submit" disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Pull GBP Coverage
          </Button>
        </form>
      }
      results={
        error ? (
          <ToolError message={error} />
        ) : (
          <>
            <ToolSection title="My Business Info">
              <ResultsTable
                rows={data?.business ?? []}
                columns={BUSINESS_COLS}
                filename="gbp-business"
              />
            </ToolSection>
            <ToolSection
              title="Reviews"
              description={
                data && data.reviewsStatus !== "ok"
                  ? `Status: ${data.reviewsStatus}`
                  : "Latest Google reviews for the matched listing."
              }
            >
              <ResultsTable
                rows={data?.reviews ?? []}
                columns={REVIEW_COLS}
                filename="gbp-reviews"
              />
            </ToolSection>
            <ToolSection title="Extended Reviews">
              <ResultsTable
                rows={data?.extendedReviews ?? []}
                columns={REVIEW_COLS}
                filename="gbp-extended-reviews"
              />
            </ToolSection>
            <ToolSection title="Questions & Answers">
              <ResultsTable
                rows={data?.qa ?? []}
                columns={QA_COLS}
                filename="gbp-qa"
              />
            </ToolSection>
            <ToolSection title="Business Listings (Local Pack)">
              <ResultsTable
                rows={data?.listings ?? []}
                columns={LISTING_COLS}
                filename="gbp-listings"
              />
            </ToolSection>
          </>
        )
      }
    />
  )
}
