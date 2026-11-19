import { sql } from 'kysely'
import type { FailureClass } from '../db/schema.ts'
import { fail } from '../errors/error.ts'
import { listMachines } from '../machines/service.ts'
import { findProject, run, type TenantCtx } from '../planning/resolve.ts'
import { listQueues } from '../queues/service.ts'

// One row per local period (of finished_at, in the tenant time zone) and job type, over the runs that ended in it.
export type IndicatorRow = {
  period: string // local YYYY-MM-DD of the day, or of the Monday for weeks
  jobType: string
  runs: number
  finished: number
  failed: number
  skipped: number
  failureClasses: Partial<Record<FailureClass, number>>
  // By cause: a requeue (an offer the machine let expire) is not an attempt, so it is not a retry.
  retries: number
  requeues: number
  // Percentiles are interpolated (percentile_cont); null when no run of the row has both ends of the span.
  queueWaitP50Ms: number | null // queued → offered
  queueWaitP90Ms: number | null
  admissionDelayP50Ms: number | null // offered → admitted
  runTimeP50Ms: number | null // started → finished
  runTimeP90Ms: number | null
  peakP50Bytes: number | null
  peakMaxBytes: number | null
  cpuSeconds: number | null
}

export type IndicatorsNow = {
  // oldestWaitMs: since the oldest run still queued; null for an empty queue.
  queues: { key: string; depth: number; oldestWaitMs: number | null }[]
  machines: { name: string; freeBytes: number | null; reservedBytes: number; reserveBytes: number | null }[]
  learnedNeeds: { jobType: string; machine: string; needBytes: number; samples: number }[]
}

type Row = {
  period: string
  job_type: string
  runs: string
  finished: string
  failed: string
  skipped: string
  failure_classes: Partial<Record<FailureClass, number>> | null
  retries: string
  requeues: string
  queue_wait_p50: number | null
  queue_wait_p90: number | null
  admission_p50: number | null
  run_time_p50: number | null
  run_time_p90: number | null
  peak_p50: number | null
  peak_max: string | null
  cpu_seconds: number | null
}

const round = (n: number | null): number | null => (n === null ? null : Math.round(n))

/**
 * Run indicators of the project over the local periods from `from` to `to`, whole periods at both ends (as getBalance
 * counts them). Periods are cut in SQL: date_trunc on the local time, and its weeks start on Monday.
 */
export function runIndicators(
  ctx: TenantCtx,
  projectKey: string,
  opts: { period: 'day' | 'week'; from: Date; to: Date },
): Promise<IndicatorRow[]> {
  if (opts.from.getTime() > opts.to.getTime()) fail('DR101', { path: '/from', reason: 'from must not be after to' })
  return run(ctx, async (trx) => {
    const project = await findProject(trx, projectKey)
    const tenant = await trx
      .selectFrom('tenants')
      .select('timezone')
      .where('id', '=', ctx.tenantId)
      .executeTakeFirstOrThrow()
    const local = (at: unknown) => sql`date_trunc(${opts.period}, ${at} at time zone ${tenant.timezone})`
    const ms = (from: string, to: string) => sql`(extract(epoch from ${sql.ref(to)} - ${sql.ref(from)}) * 1000)::float8`
    const p = (fraction: number, value: unknown) =>
      sql`percentile_cont(${fraction}::float8) within group (order by ${value})`
    const { rows } = await sql<Row>`
      with ended as (
        select ${local(sql.ref('r.finished_at'))} as local_period, jt.key as job_type, r.*
        from runs r join job_types jt on jt.id = r.job_type_id
        where r.project_id = ${project.id}
          and r.finished_at is not null
          and ${local(sql.ref('r.finished_at'))}
            between ${local(sql`${opts.from}::timestamptz`)} and ${local(sql`${opts.to}::timestamptz`)}
      ),
      classes as (
        select local_period, job_type, jsonb_object_agg(failure_class, n) as failure_classes
        from (
          select local_period, job_type, failure_class, count(*) as n
          from ended where failure_class is not null
          group by local_period, job_type, failure_class
        ) c
        group by local_period, job_type
      )
      select
        to_char(e.local_period, 'YYYY-MM-DD') as period,
        e.job_type,
        count(*) as runs,
        count(*) filter (where e.state = 'finished') as finished,
        count(*) filter (where e.state = 'failed') as failed,
        count(*) filter (where e.state = 'skipped') as skipped,
        c.failure_classes,
        count(*) filter (where e.cause = 'retry') as retries,
        count(*) filter (where e.cause = 'requeue') as requeues,
        ${p(0.5, ms('e.queued_at', 'e.offered_at'))} as queue_wait_p50,
        ${p(0.9, ms('e.queued_at', 'e.offered_at'))} as queue_wait_p90,
        ${p(0.5, ms('e.offered_at', 'e.admitted_at'))} as admission_p50,
        ${p(0.5, ms('e.started_at', 'e.finished_at'))} as run_time_p50,
        ${p(0.9, ms('e.started_at', 'e.finished_at'))} as run_time_p90,
        ${p(0.5, sql`e.peak_private_bytes::float8`)} as peak_p50,
        max(e.peak_private_bytes) as peak_max,
        sum(e.cpu_seconds) as cpu_seconds
      from ended e left join classes c using (local_period, job_type)
      group by e.local_period, e.job_type, c.failure_classes
      order by e.local_period, e.job_type`.execute(trx)
    // Byte counts fit a JS number: the protocol refuses any past 2^53 (executor/protocol.ts).
    return rows.map((r) => ({
      period: r.period,
      jobType: r.job_type,
      runs: Number(r.runs),
      finished: Number(r.finished),
      failed: Number(r.failed),
      skipped: Number(r.skipped),
      failureClasses: r.failure_classes ?? {},
      retries: Number(r.retries),
      requeues: Number(r.requeues),
      queueWaitP50Ms: round(r.queue_wait_p50),
      queueWaitP90Ms: round(r.queue_wait_p90),
      admissionDelayP50Ms: round(r.admission_p50),
      runTimeP50Ms: round(r.run_time_p50),
      runTimeP90Ms: round(r.run_time_p90),
      peakP50Bytes: round(r.peak_p50),
      peakMaxBytes: r.peak_max === null ? null : Number(r.peak_max),
      cpuSeconds: r.cpu_seconds,
    }))
  })
}

/** Queue waits, machine memory and learned needs as they stand, from the same figures the scheduler places by. */
export async function indicatorsNow(ctx: TenantCtx, projectKey: string): Promise<IndicatorsNow> {
  const [queues, machines, learnedNeeds] = await Promise.all([
    listQueues(ctx, projectKey),
    listMachines(ctx),
    run(ctx, async (trx) => {
      const project = await findProject(trx, projectKey)
      return trx
        .selectFrom('learned_needs as n')
        .innerJoin('job_types as jt', 'jt.id', 'n.job_type_id')
        .innerJoin('machines as m', 'm.id', 'n.machine_id')
        .select(['jt.key as job_type', 'm.name as machine', 'n.need_bytes', 'n.samples'])
        .where('n.project_id', '=', project.id)
        .where('m.revoked_at', 'is', null)
        .orderBy('jt.key')
        .orderBy('m.name')
        .execute()
    }),
  ])
  const now = Date.now()
  return {
    queues: queues.map((q) => ({
      key: q.key,
      depth: q.depth,
      oldestWaitMs: q.oldestQueuedAt ? Math.max(0, now - q.oldestQueuedAt.getTime()) : null,
    })),
    machines: machines.map((m) => ({
      name: m.name,
      freeBytes: m.freeBytes,
      reservedBytes: m.reservedBytes,
      reserveBytes: m.reserveBytes,
    })),
    learnedNeeds: learnedNeeds.map((n) => ({
      jobType: n.job_type,
      machine: n.machine,
      needBytes: Number(n.need_bytes),
      samples: n.samples,
    })),
  }
}
