import { type Static, Type } from '@sinclair/typebox'
import { type Kysely, sql } from 'kysely'
import type { Database, JobState } from '../db/schema.ts'
import { fail } from '../errors/error.ts'
import { resolver } from '../jobs/enqueue.ts'
import { type Ctx, findProject, run, type TenantCtx, type Trx } from '../planning/resolve.ts'
import { withTenant } from '../tenancy/scope.ts'
import { validate } from '../validate.ts'
import { notifyScheduler } from './notify.ts'
import type { SchedulerLog } from './scheduler.ts'

const INT_MAX = 2147483647
// Lower than a minute would only pile up jobs: the tick that fires them runs on a poll of seconds.
const MIN_EVERY_S = 60

/** What `PUT /schedules/:schedule` takes. It replaces the whole definition: an omitted `queue` is `default`, an omitted
 * `machine` is any machine, an omitted `enabled` is true. Exactly one of `everyS` and `dailyAt`. */
export const ScheduleSettings = Type.Object(
  {
    jobType: Type.String({ minLength: 1, maxLength: 200 }),
    cwd: Type.String({ minLength: 1, maxLength: 1000 }),
    queue: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    machine: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    everyS: Type.Optional(Type.Integer({ minimum: MIN_EVERY_S, maximum: INT_MAX })),
    // Wall clock of the tenant time zone.
    dailyAt: Type.Optional(Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' })),
    enabled: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
)

export type ScheduleSettings = Static<typeof ScheduleSettings>

export type ScheduleView = {
  key: string
  jobType: string
  every: number | null
  // HH:MM in the tenant time zone.
  dailyAt: string | null
  enabled: boolean
  nextDueAt: Date
  timeZone: string
  lastJob: { id: string; state: JobState } | null
}

type Timing = { every_s: number | null; daily_at: string | null }

/**
 * The first fire time after `after`. `every_s` counts from `after`; `daily_at` is the next HH:MM strictly after it on
 * the wall clock of `timezone`, worked out in SQL so the zone's rules (daylight saving included) apply: the day is
 * added to the local time, not to the instant.
 */
export async function nextDue(trx: Trx, schedule: Timing, after: Date, timezone: string): Promise<Date> {
  if (schedule.every_s !== null) return new Date(after.getTime() + schedule.every_s * 1000)
  const { rows } = await sql<{ due: Date }>`
    with local as (
      select date_trunc('day', ${after}::timestamptz at time zone ${timezone}::text) + ${schedule.daily_at}::time as at
    )
    select (case when (at at time zone ${timezone}::text) > ${after}::timestamptz then at else at + interval '1 day' end)
      at time zone ${timezone}::text as due
    from local`.execute(trx)
  return rows[0].due
}

async function tenantTimezone(trx: Trx, tenantId: string): Promise<string> {
  const { timezone } = await trx
    .selectFrom('tenants')
    .select('timezone')
    .where('id', '=', tenantId)
    .executeTakeFirstOrThrow()
  return timezone
}

/**
 * Fires every enabled schedule due at `now`, each in its own transaction, and returns how many made a job. The
 * scheduler runs it in every tick. A schedule whose previous job is still open fires nothing (the clock moves on, so
 * runs never pile up behind a slow one). The next fire is counted from `now`, not from the missed time, so a schedule
 * missed several times while serve was down fires once.
 *
 * The rows come from due_schedules (0014) across tenants; each is locked with skip locked and checked again inside its
 * tenant, so two ticks at once (or a tick of another serve) fire a schedule once.
 */
export async function fireDueSchedules(db: Kysely<Database>, now: Date, log: SchedulerLog): Promise<number> {
  const { rows } = await sql<{ tenant_id: string; schedule_id: string }>`
    select tenant_id, schedule_id from due_schedules(${now})`.execute(db)
  let fired = 0
  for (const row of rows) {
    try {
      if (await withTenant(db, row.tenant_id, (trx) => fireOne(trx, row.tenant_id, row.schedule_id, now, log))) fired++
    } catch (err) {
      // The database, usually; the schedule is still due, so the next tick tries again.
      log.error({ err, schedule: row.schedule_id }, 'schedule fire failed')
    }
  }
  return fired
}

async function fireOne(trx: Trx, tenantId: string, scheduleId: string, now: Date, log: SchedulerLog): Promise<boolean> {
  const schedule = await trx
    .selectFrom('schedules')
    .selectAll()
    .where('id', '=', scheduleId)
    .where('enabled', '=', true)
    .where('next_due_at', '<=', now)
    .forUpdate()
    .skipLocked()
    .executeTakeFirst()
  if (!schedule) return false
  const nextDueAt = await nextDue(trx, schedule, now, await tenantTimezone(trx, tenantId))
  const previous =
    schedule.last_job_id === null
      ? undefined
      : await trx.selectFrom('jobs').select('state').where('id', '=', schedule.last_job_id).executeTakeFirst()
  if (previous?.state === 'open') {
    await trx.updateTable('schedules').set({ next_due_at: nextDueAt }).where('id', '=', scheduleId).execute()
    log.warn({ schedule: scheduleId, job: schedule.last_job_id }, 'schedule skipped; its previous job is still open')
    return false
  }
  const job = await trx
    .insertInto('jobs')
    .values({
      tenant_id: tenantId,
      project_id: schedule.project_id,
      job_type_id: schedule.job_type_id,
      queue_id: schedule.queue_id,
      machine_id: schedule.machine_id,
      cwd: schedule.cwd,
      created_by: schedule.created_by,
      schedule_id: scheduleId,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  await trx
    .insertInto('runs')
    .values({
      tenant_id: tenantId,
      project_id: schedule.project_id,
      job_id: job.id,
      job_type_id: schedule.job_type_id,
    })
    .execute()
  await trx
    .updateTable('schedules')
    .set({ last_job_id: job.id, next_due_at: nextDueAt })
    .where('id', '=', scheduleId)
    .execute()
  await notifyScheduler(trx, tenantId)
  return true
}

/** Creates the schedule `i.key` of the project, or replaces its definition. Its clock restarts only when the timing
 * changes or it is enabled again, so saving the same schedule twice does not push the next fire out. */
export async function putSchedule(
  ctx: Ctx,
  projectKey: string,
  i: { key: string } & ScheduleSettings,
): Promise<ScheduleView> {
  const { key, ...settings } = i
  validate(Type.String({ minLength: 1, maxLength: 200 }), key)
  validate(ScheduleSettings, settings)
  if ((settings.everyS === undefined) === (settings.dailyAt === undefined)) {
    fail('DR101', { path: '/everyS', reason: 'give exactly one of everyS and dailyAt' })
  }
  return run(ctx, async (trx) => {
    const project = await findProject(trx, projectKey)
    const values = await resolver(
      trx,
      project.id,
    )({
      jobTypeKey: settings.jobType,
      cwd: settings.cwd,
      queueKey: settings.queue,
      machineName: settings.machine,
    })
    const timing: Timing = { every_s: settings.everyS ?? null, daily_at: settings.dailyAt ?? null }
    const enabled = settings.enabled ?? true
    const row = {
      job_type_id: values.job_type_id,
      queue_id: values.queue_id,
      machine_id: values.machine_id,
      cwd: values.cwd,
      ...timing,
      enabled,
    }
    const timezone = await tenantTimezone(trx, ctx.tenantId)
    await trx
      .insertInto('schedules')
      .values({
        tenant_id: ctx.tenantId,
        project_id: project.id,
        key,
        created_by: ctx.actor.id,
        next_due_at: await nextDue(trx, timing, new Date(), timezone),
        ...row,
      })
      .onConflict((oc) => oc.columns(['project_id', 'key']).doNothing())
      .execute()
    // Locked so two puts of one schedule cannot interleave.
    const current = await trx
      .selectFrom('schedules')
      .select(['id', 'every_s', 'daily_at', 'enabled'])
      .where('project_id', '=', project.id)
      .where('key', '=', key)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow()
    const restart =
      current.every_s !== timing.every_s ||
      current.daily_at?.slice(0, 5) !== timing.daily_at ||
      (enabled && !current.enabled)
    await trx
      .updateTable('schedules')
      .set({
        ...row,
        updated_at: sql<Date>`now()`,
        ...(restart ? { next_due_at: await nextDue(trx, timing, new Date(), timezone) } : {}),
      })
      .where('id', '=', current.id)
      .execute()
    const [view] = await scheduleViews(trx, project.id, key)
    return view
  })
}

/** The project's schedules by key. */
export function listSchedules(ctx: TenantCtx, projectKey: string): Promise<ScheduleView[]> {
  return run(ctx, async (trx) => scheduleViews(trx, (await findProject(trx, projectKey)).id))
}

async function scheduleViews(trx: Trx, projectId: string, onlyKey?: string): Promise<ScheduleView[]> {
  let query = trx
    .selectFrom('schedules as s')
    .innerJoin('job_types as jt', 'jt.id', 's.job_type_id')
    .innerJoin('tenants as t', 't.id', 's.tenant_id')
    .leftJoin('jobs as j', 'j.id', 's.last_job_id')
    .select([
      's.key',
      'jt.key as job_type',
      's.every_s',
      's.daily_at',
      's.enabled',
      's.next_due_at',
      't.timezone',
      'j.id as job_id',
      'j.state as job_state',
    ])
    .where('s.project_id', '=', projectId)
    .orderBy('s.key')
  if (onlyKey !== undefined) query = query.where('s.key', '=', onlyKey)
  return (await query.execute()).map((row) => ({
    key: row.key,
    jobType: row.job_type,
    every: row.every_s,
    dailyAt: row.daily_at === null ? null : row.daily_at.slice(0, 5),
    enabled: row.enabled,
    nextDueAt: row.next_due_at,
    timeZone: row.timezone,
    lastJob: row.job_id === null || row.job_state === null ? null : { id: row.job_id, state: row.job_state },
  }))
}
