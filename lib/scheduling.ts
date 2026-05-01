import "server-only"

/**
 * Scheduling math for the Scheduled Tasks tab.
 *
 * One row in `task_schedules` per (partner_id, kind) pair. The desktop
 * Routine bot polls "what's due" via /api/scheduled-tasks/run; that route
 * calls `computeNextRunAt()` here to advance `next_run_at` after each fire.
 *
 * Anchor hours are kind-aware so two task kinds scheduled for the same
 * partner on the same day don't stack: crawls run at 09:00 UTC, audits
 * at 06:00 UTC. Both are before the typical desktop Routine tick (mid
 * morning ET), so the routine catches up on missed runs the next day.
 */

export type TaskKind = "technical_crawl" | "full_audit"

export type Frequency = "daily" | "weekly" | "monthly"

/**
 * Hour-of-UTC anchor per task kind. Stagger keeps full audits (heavier,
 * more expensive) out of the crawl wall-time bucket. 06:00 UTC = 1am EST,
 * 09:00 UTC = 4am EST — both well before the user's Routine fires.
 */
const ANCHOR_HOUR_UTC: Record<TaskKind, number> = {
  full_audit: 6,
  technical_crawl: 9,
}

export interface NextRunOptions {
  dayOfWeek?: number | null
  dayOfMonth?: number | null
  /** Defaults to `new Date()`. Tests override. */
  from?: Date
}

/**
 * Compute the next time a schedule should fire. "Past today" always rolls
 * to the next period — the routine catches up on missed runs by firing
 * them on the next tick after the user's machine wakes up.
 */
export function computeNextRunAt(
  kind: TaskKind,
  frequency: Frequency,
  opts: NextRunOptions = {},
): Date {
  const anchor = opts.from ?? new Date()
  const hour = ANCHOR_HOUR_UTC[kind]
  if (frequency === "daily") {
    return nextDaily(anchor, hour)
  }
  if (frequency === "weekly") {
    if (opts.dayOfWeek == null) {
      throw new Error("dayOfWeek required for weekly schedule")
    }
    return nextWeekly(anchor, opts.dayOfWeek, hour)
  }
  if (opts.dayOfMonth == null) {
    throw new Error("dayOfMonth required for monthly schedule")
  }
  return nextMonthly(anchor, opts.dayOfMonth, hour)
}

function nextDaily(from: Date, hour: number): Date {
  const next = new Date(
    Date.UTC(
      from.getUTCFullYear(),
      from.getUTCMonth(),
      from.getUTCDate(),
      hour,
    ),
  )
  if (next.getTime() <= from.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1)
  }
  return next
}

function nextWeekly(from: Date, dayOfWeek: number, hour: number): Date {
  const next = new Date(
    Date.UTC(
      from.getUTCFullYear(),
      from.getUTCMonth(),
      from.getUTCDate(),
      hour,
    ),
  )
  if (next.getTime() <= from.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1)
  }
  const baseDow = next.getUTCDay()
  const delta = (dayOfWeek - baseDow + 7) % 7
  next.setUTCDate(next.getUTCDate() + delta)
  return next
}

function nextMonthly(from: Date, dayOfMonth: number, hour: number): Date {
  const year = from.getUTCFullYear()
  const month = from.getUTCMonth()
  const thisMonth = clampedMonthly(year, month, dayOfMonth, hour)
  if (thisMonth.getTime() > from.getTime()) return thisMonth
  return clampedMonthly(year, month + 1, dayOfMonth, hour)
}

function clampedMonthly(
  year: number,
  monthOffset: number,
  day: number,
  hour: number,
): Date {
  const safeYear = year + Math.floor(monthOffset / 12)
  const safeMonth = ((monthOffset % 12) + 12) % 12
  const lastDay = new Date(Date.UTC(safeYear, safeMonth + 1, 0)).getUTCDate()
  const clamped = Math.min(Math.max(1, day), lastDay)
  return new Date(Date.UTC(safeYear, safeMonth, clamped, hour))
}

// Human-readable labels for the schedule pipeline UI.
export const KIND_LABELS: Record<TaskKind, string> = {
  technical_crawl: "Technical Crawl",
  full_audit: "Full Audit",
}

const WEEKDAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const

export function describeSchedule(args: {
  frequency: Frequency
  dayOfWeek: number | null
  dayOfMonth: number | null
}): string {
  if (args.frequency === "daily") return "Every day"
  if (args.frequency === "weekly") {
    return `Every ${WEEKDAY_LABELS[args.dayOfWeek ?? 0] ?? "?"}`
  }
  return `Monthly on day ${args.dayOfMonth ?? "?"}`
}
