import { redirect } from "next/navigation"

/**
 * The Onboarding category currently has a single workflow (Initial Strategy).
 * Visiting `/onboarding` directly forwards there so the URL doesn't dead-end
 * on a placeholder. When more onboarding workflows ship, replace this with an
 * index page listing them.
 */
export default function OnboardingPage() {
  redirect("/onboarding/initial-strategy")
}
