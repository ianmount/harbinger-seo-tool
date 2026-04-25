import type { ReactNode } from "react"

/**
 * Editorial page header used at the top of every tab.
 *
 * Pattern (from design/DESIGN_NOTES.md):
 *   - Red eyebrow kicker (uppercase Montserrat 800, 0.22em tracking)
 *   - Sans 900 H1 with optional italic-serif `tail` continuation
 *   - Serif body subtitle, ink-2, with sans-bold inline on key terms
 *
 * Use sans-bold inline (`<b>`) inside `subtitle` for proper-noun and
 * number emphasis — the signature Harbinger move.
 */
export function PageHeader({
  eyebrow,
  title,
  tail,
  subtitle,
}: {
  eyebrow: string
  title: ReactNode
  tail?: ReactNode
  subtitle?: ReactNode
}) {
  return (
    <header>
      <p className="eyebrow eyebrow-red">{eyebrow}</p>
      <h1 className="mt-2 font-sans text-[28px] font-extrabold leading-[1.08] tracking-[-0.01em] text-foreground sm:text-[32px]">
        {title}
        {tail ? (
          <em className="font-serif font-medium italic text-ink-2">
            {" "}
            {tail}
          </em>
        ) : null}
      </h1>
      {subtitle ? (
        <p className="mt-3 max-w-[680px] font-serif text-[15.5px] leading-relaxed text-ink-2">
          {subtitle}
        </p>
      ) : null}
    </header>
  )
}
