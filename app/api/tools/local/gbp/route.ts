import { z } from "zod"
import { dfsCost, dfsItems, locationFields, runTool } from "@/lib/tool-route"
import { dfsRequest } from "@/lib/dataforseo"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const Input = z.object({
  keyword: z.string().min(1),
  location_code: z.number().int().optional(),
  location_name: z.string().optional(),
  language_code: z.string().default("en"),
  limit: z.number().int().min(1).max(100).default(50),
})

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

const POLL_INTERVAL_MS = 10_000
const POLL_ATTEMPTS = 8 // ~80s max wait per async task

async function postReviewsTask(
  endpoint: string,
  body: unknown,
): Promise<string | null> {
  const env = (await dfsRequest(endpoint, body).catch(() => null)) as
    | { tasks?: { id?: string; status_code?: number }[] }
    | null
  const task = env?.tasks?.[0]
  if (!task) return null
  // 20100 = "Task Created" success; 20000 = ready. Either is fine.
  if (task.status_code === 20100 || task.status_code === 20000) {
    return task.id ?? null
  }
  return task.id ?? null
}

async function pollTaskGet<T>(
  endpoint: string,
  taskId: string,
): Promise<T | null> {
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    const env = (await dfsRequest(
      `${endpoint}/${taskId}`,
      undefined,
    ).catch(() => null)) as
      | { tasks?: { status_code?: number; result?: unknown }[] }
      | null
    const task = env?.tasks?.[0]
    if (!task) continue
    if (task.status_code === 20000 && task.result) return env as T
    if (task.status_code && task.status_code >= 40000) return null
  }
  return null
}

function mapReviews(envelope: unknown): ReviewRow[] {
  return dfsItems<{
    review_text?: string | null
    rating?: { value?: number | null } | number | null
    profile_name?: string | null
    timestamp?: string | null
    source?: string | null
  }>(envelope).map((it) => ({
    source: it.source ?? "google",
    profile_name: it.profile_name ?? null,
    rating:
      typeof it.rating === "object" && it.rating
        ? (it.rating.value ?? null)
        : typeof it.rating === "number"
          ? it.rating
          : null,
    review_text: it.review_text ?? null,
    timestamp: it.timestamp ?? null,
  }))
}

export async function POST(request: Request) {
  return runTool<typeof Input, Data>(request, Input, async (input, { dfs }) => {
    const loc = locationFields(input)
    const baseBody = [
      { keyword: input.keyword, ...loc, limit: input.limit },
    ]

    // Live endpoints in parallel.
    const [businessEnv, qaEnv, listingsEnv] = await Promise.all([
      dfs("/v3/business_data/google/my_business_info/live", baseBody),
      dfs(
        "/v3/business_data/google/questions_and_answers/live",
        [{ keyword: input.keyword, ...loc }],
      ).catch(() => null),
      dfs(
        "/v3/business_data/business_listings/search/live",
        [{ keyword: input.keyword, ...loc, limit: input.limit }],
      ).catch(() => null),
    ])

    const business: BusinessRow[] = dfsItems<{
      title?: string
      category?: string | null
      rating?: { value?: number | null; votes_count?: number | null }
      address?: string | null
      phone?: string | null
      url?: string | null
      place_id?: string | null
    }>(businessEnv).map((it) => ({
      title: it.title ?? "",
      category: it.category ?? null,
      rating: it.rating?.value ?? null,
      rating_count: it.rating?.votes_count ?? null,
      address: it.address ?? null,
      phone: it.phone ?? null,
      url: it.url ?? null,
      place_id: it.place_id ?? null,
    }))

    // Async task_post for reviews + extended_reviews. We submit both in
    // parallel, then poll with a bounded total wait so the route stays
    // within `maxDuration`. If tasks aren't ready in time, the
    // `reviewsStatus` field reports "pending" and the section is empty.
    const [reviewsTaskId, extendedTaskId] = await Promise.all([
      postReviewsTask("/v3/business_data/google/reviews/task_post", [
        { keyword: input.keyword, ...loc, depth: 100 },
      ]),
      postReviewsTask(
        "/v3/business_data/google/extended_reviews/task_post",
        [{ keyword: input.keyword, ...loc, depth: 100 }],
      ),
    ])

    let reviewsStatus = "ok"
    const [reviewsEnv, extendedEnv] = await Promise.all([
      reviewsTaskId
        ? pollTaskGet<unknown>(
            "/v3/business_data/google/reviews/task_get",
            reviewsTaskId,
          )
        : Promise.resolve(null),
      extendedTaskId
        ? pollTaskGet<unknown>(
            "/v3/business_data/google/extended_reviews/task_get",
            extendedTaskId,
          )
        : Promise.resolve(null),
    ])
    if (reviewsTaskId && !reviewsEnv) reviewsStatus = "pending (re-run in 2-3 min)"

    const reviews: ReviewRow[] = reviewsEnv ? mapReviews(reviewsEnv) : []
    const extendedReviews: ReviewRow[] = extendedEnv
      ? mapReviews(extendedEnv)
      : []

    const qa: QaRow[] = qaEnv
      ? dfsItems<{
          question?: string
          answers_count?: number | null
          asker_name?: string | null
          top_answer_text?: string | null
        }>(qaEnv).map((it) => ({
          question: it.question ?? "",
          answers_count: it.answers_count ?? null,
          asker_name: it.asker_name ?? null,
          top_answer: it.top_answer_text ?? null,
        }))
      : []

    const listings: ListingRow[] = listingsEnv
      ? dfsItems<{
          title?: string
          description?: string | null
          category?: string | null
          rating?: { value?: number | null; votes_count?: number | null }
          address_info?: { address?: string | null }
          address?: string | null
        }>(listingsEnv).map((it) => ({
          title: it.title ?? "",
          description: it.description ?? null,
          category: it.category ?? null,
          rating: it.rating?.value ?? null,
          rating_count: it.rating?.votes_count ?? null,
          address: it.address ?? it.address_info?.address ?? null,
        }))
      : []

    return {
      data: {
        business,
        reviews,
        extendedReviews,
        qa,
        listings,
        reviewsStatus,
      },
      endpoints: [
        "/v3/business_data/google/my_business_info/live",
        "/v3/business_data/google/reviews/task_post",
        "/v3/business_data/google/extended_reviews/task_post",
        ...(qaEnv ? ["/v3/business_data/google/questions_and_answers/live"] : []),
        ...(listingsEnv ? ["/v3/business_data/business_listings/search/live"] : []),
      ],
      costUsd: dfsCost(businessEnv, qaEnv, listingsEnv, reviewsEnv, extendedEnv),
    }
  })
}
