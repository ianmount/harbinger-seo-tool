import { PageHeader } from "@/components/PageHeader"

export default function OnboardingPage() {
  return (
    <div className="space-y-10">
      <PageHeader
        eyebrow="Onboarding"
        title="Partner kickoff workflows"
        tail="— coming soon."
        subtitle={
          <>
            This category will house the one-time setup flows new partners go
            through before entering the recurring cycle.
          </>
        }
      />
      <div className="flex min-h-[40vh] items-center justify-center rounded-md border border-dashed border-line-strong/70 px-6 py-16 text-center">
        <p className="font-serif text-[15px] italic text-ink-3">
          No onboarding workflows yet — coming soon.
        </p>
      </div>
    </div>
  )
}
