import { fail } from '../errors/error.ts'

// Windows of the per-period reads (GET /balance, GET /indicators): defaults when from/to are omitted, and caps so one
// request cannot ask for years of rows.
const DAY_MS = 86_400_000
const WINDOW = { day: { defaultDays: 13, maxDays: 366 }, week: { defaultDays: 7 * 11, maxDays: 3660 } }

// Strict ISO 8601: a date, or a date-time with an explicit zone (a zoneless time would take the server's zone).
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})(T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,9})?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d))?$/

// A date without a time is UTC midnight, not tenant midnight; callers wanting local days send instants.
function instant(value: string | undefined, path: string): Date | undefined {
  if (value === undefined) return undefined
  const match = ISO_INSTANT.exec(value)
  // Date.UTC rolls 2026-02-31 over into March; reading the day back catches it.
  const [year, month, day] = [Number(match?.[1]), Number(match?.[2]), Number(match?.[3])]
  const calendar = new Date(Date.UTC(year, month - 1, day))
  const date = new Date(value)
  if (!match || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day || Number.isNaN(date.getTime())) {
    fail('DR101', { path, reason: 'expected an ISO 8601 date (YYYY-MM-DD) or date-time with a zone' })
  }
  return date
}

/** The from/to of a per-period read, defaulted and capped; DR101 on a malformed, inverted or too long window. */
export function periodWindow(
  what: string,
  q: { period: 'day' | 'week'; from?: string; to?: string },
): { period: 'day' | 'week'; from: Date; to: Date } {
  const window = WINDOW[q.period]
  const to = instant(q.to, 'querystring/to') ?? new Date()
  const from = instant(q.from, 'querystring/from') ?? new Date(to.getTime() - window.defaultDays * DAY_MS)
  if (from.getTime() > to.getTime()) fail('DR101', { path: 'querystring/from', reason: 'must not be after to' })
  if (to.getTime() - from.getTime() > window.maxDays * DAY_MS) {
    fail('DR101', { path: 'querystring/from', reason: `a ${q.period} ${what} spans at most ${window.maxDays} days` })
  }
  return { period: q.period, from, to }
}
