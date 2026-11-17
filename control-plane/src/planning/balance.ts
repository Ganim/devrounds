import { fail } from '../errors/error.ts'
import { type Ctx, findProject, run } from './resolve.ts'

export type BalanceEvent = {
  kind: 'add_task' | 'transition'
  taskKey: string
  at: Date
  from?: string
  to?: string
}

export type BalanceRow = {
  periodStart: string // local YYYY-MM-DD of the day, or of the Monday for weeks
  done: number
  opened: number
  cancelled: number
  hoursInProgress: number
  avgCycleHours: number | null
}

export type BalanceOpts = { timezone: string; period: 'day' | 'week'; from: Date; to: Date; now: Date }

type Acc = BalanceRow & { cycleMs: number[]; hoursMs: number }

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

// Wall-clock fields of an instant in `timeZone`, as a UTC-based timestamp (so plain arithmetic works on them).
function wallClockAsUtc(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(at)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
}

function dayString(utcMidnight: number): string {
  return new Date(utcMidnight).toISOString().slice(0, 10)
}

function addDays(day: string, days: number): string {
  return dayString(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS)
}

// The instant of local midnight on `day` (YYYY-MM-DD). The offset is read at the guess and again at the corrected
// instant, so a zone whose offset changes in between (DST) still lands on the right boundary.
function localMidnight(day: string, timeZone: string): number {
  const wall = Date.parse(`${day}T00:00:00Z`)
  let instant = wall - (wallClockAsUtc(new Date(wall), timeZone) - wall)
  instant = wall - (wallClockAsUtc(new Date(instant), timeZone) - instant)
  return instant
}

function periodStartOf(at: Date, opts: Pick<BalanceOpts, 'timezone' | 'period'>): string {
  const local = wallClockAsUtc(at, opts.timezone)
  const midnight = local - (local % DAY_MS)
  if (opts.period === 'day') return dayString(midnight)
  const sinceMonday = (new Date(midnight).getUTCDay() + 6) % 7
  return dayString(midnight - sinceMonday * DAY_MS)
}

// `done` and `cancelled` count transitions into that state in the period; a reopen does not uncount an earlier done,
// so a past period never changes after the fact.
// Hours: each stretch in `in_progress` (from the move in until the next move out, or `now`) is split at local period
// boundaries. Cycle time: first move into in_progress to a move into done, counted in the period of the done.
export function computeBalance(events: BalanceEvent[], opts: BalanceOpts): BalanceRow[] {
  const last = periodStartOf(opts.to, opts)
  const step = opts.period === 'day' ? 1 : 7
  const starts: string[] = []
  const rows = new Map<string, Acc>()
  for (let s = periodStartOf(opts.from, opts); s <= last; s = addDays(s, step)) {
    starts.push(s)
    rows.set(s, {
      periodStart: s,
      done: 0,
      opened: 0,
      cancelled: 0,
      hoursInProgress: 0,
      avgCycleHours: null,
      cycleMs: [],
      hoursMs: 0,
    })
  }

  const intervals: { start: number; end: number }[] = []
  const open = new Map<string, Date>()
  const firstStart = new Map<string, Date>()
  const ordered = [...events].sort((a, b) => a.at.getTime() - b.at.getTime())
  for (const e of ordered) {
    const row = rows.get(periodStartOf(e.at, opts))
    if (e.kind === 'add_task') {
      if (row) row.opened++
      continue
    }
    if (e.to === 'done' && row) {
      row.done++
      const started = firstStart.get(e.taskKey)
      if (started) row.cycleMs.push(e.at.getTime() - started.getTime())
    }
    if (e.to === 'cancelled' && row) row.cancelled++
    const since = open.get(e.taskKey)
    if (e.to === 'in_progress') {
      if (!since) open.set(e.taskKey, e.at)
      if (!firstStart.has(e.taskKey)) firstStart.set(e.taskKey, e.at)
    } else if (since) {
      intervals.push({ start: since.getTime(), end: e.at.getTime() })
      open.delete(e.taskKey)
    }
  }
  for (const since of open.values()) intervals.push({ start: since.getTime(), end: opts.now.getTime() })

  const bounds = starts.map((s) => localMidnight(s, opts.timezone))
  bounds.push(localMidnight(addDays(last, step), opts.timezone))
  for (const { start, end } of intervals) {
    starts.forEach((s, i) => {
      const overlap = Math.min(end, bounds[i + 1] as number) - Math.max(start, bounds[i] as number)
      if (overlap > 0) (rows.get(s) as Acc).hoursMs += overlap
    })
  }

  return starts.map((s) => {
    const { cycleMs, hoursMs, ...row } = rows.get(s) as Acc
    const avgMs = cycleMs.reduce((a, b) => a + b, 0) / cycleMs.length
    return {
      ...row,
      hoursInProgress: round1(hoursMs / HOUR_MS),
      avgCycleHours: cycleMs.length > 0 ? round1(avgMs / HOUR_MS) : null,
    }
  })
}

export function getBalance(
  ctx: Ctx,
  projectKey: string,
  opts: { period: 'day' | 'week'; from: Date; to: Date; now?: Date },
): Promise<BalanceRow[]> {
  if (opts.from.getTime() > opts.to.getTime()) fail('DR101', { path: '/from', reason: 'from must not be after to' })
  return run(ctx, async (trx) => {
    const project = await findProject(trx, projectKey)
    const tenant = await trx
      .selectFrom('tenants')
      .select('timezone')
      .where('id', '=', ctx.tenantId)
      .executeTakeFirstOrThrow()
    const rows = await trx
      .selectFrom('plan_events')
      .select(['kind', 'data', 'at'])
      .where('project_id', '=', project.id)
      .where('kind', 'in', ['add_task', 'transition'])
      .orderBy('id')
      .execute()
    const events = rows.map((r): BalanceEvent => {
      const data = (typeof r.data === 'string' ? JSON.parse(r.data) : r.data) as Record<string, string>
      return r.kind === 'add_task'
        ? { kind: 'add_task', taskKey: data.key as string, at: r.at }
        : { kind: 'transition', taskKey: data.taskKey as string, at: r.at, from: data.from, to: data.to }
    })
    return computeBalance(events, { ...opts, timezone: tenant.timezone, now: opts.now ?? new Date() })
  })
}
