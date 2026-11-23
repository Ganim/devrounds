import { sql } from 'kysely'
import { fail } from '../errors/error.ts'
import { findProject, run, type TenantCtx } from '../planning/resolve.ts'

// One row per local period (of gates.finished_at, in the tenant time zone) and gate key, over the gates that ended in it.
export type GateIndicatorRow = {
  period: string // local YYYY-MM-DD of the day, or of the Monday for weeks
  gate: string // gates.key
  gates: number
  passed: number
  failed: number
  cancelled: number
  // passed / (passed + failed); null when neither happened (cancelled gates say nothing about the code).
  passRate: number | null
  // Checks that were cache hits / all checks of the gates; null when the gates have no checks.
  cacheHitShare: number | null
  // created → finished, interpolated (percentile_cont).
  wallP50Ms: number | null
  wallP90Ms: number | null
}

// One row per local period and check job type. A check is the job's latest run.
export type CheckIndicatorRow = {
  period: string
  jobType: string
  checks: number
  red: number // failed with class check_red
  failed: number // failed, whatever the class
  cached: number
}

type GateRow = {
  period: string
  gate: string
  gates: string
  passed: string
  failed: string
  cancelled: string
  checks: string
  cached: string
  wall_p50: number | null
  wall_p90: number | null
}

type CheckRow = { period: string; job_type: string; checks: string; red: string; failed: string; cached: string }

const round = (n: number | null): number | null => (n === null ? null : Math.round(n))

/**
 * Gate indicators of the project over the local periods from `from` to `to`, whole periods at both ends (as
 * runIndicators cuts them: date_trunc on the local time, weeks from Monday). Only ended gates count, by finished_at.
 * Checks are read from each gate's latest run per job, so a retried check counts once, as its last attempt.
 */
export function gateIndicators(
  ctx: TenantCtx,
  projectKey: string,
  opts: { period: 'day' | 'week'; from: Date; to: Date },
): Promise<{ gates: GateIndicatorRow[]; checks: CheckIndicatorRow[] }> {
  if (opts.from.getTime() > opts.to.getTime()) fail('DR101', { path: '/from', reason: 'from must not be after to' })
  return run(ctx, async (trx) => {
    const project = await findProject(trx, projectKey)
    const tenant = await trx
      .selectFrom('tenants')
      .select('timezone')
      .where('id', '=', ctx.tenantId)
      .executeTakeFirstOrThrow()
    const local = (at: unknown) => sql`date_trunc(${opts.period}, ${at} at time zone ${tenant.timezone})`
    const wall = sql`(extract(epoch from g.finished_at - g.created_at) * 1000)::float8`
    const p = (fraction: number) => sql`percentile_cont(${fraction}::float8) within group (order by ${wall})`
    // The latest run of every job of the ended gates in the window.
    const ended = sql`
      ended as (
        select g.id, g.key, g.state, g.created_at, g.finished_at,
          ${local(sql.ref('g.finished_at'))} as local_period
        from gates g
        where g.project_id = ${project.id}
          and g.state <> 'running'
          and g.finished_at is not null
          and ${local(sql.ref('g.finished_at'))}
            between ${local(sql`${opts.from}::timestamptz`)} and ${local(sql`${opts.to}::timestamptz`)}
      ),
      checks as (
        select e.id as gate_id, e.local_period, jt.key as job_type, r.state as run_state,
          r.failure_class, r.cached_from_run_id
        from ended e
        join gates g on g.id = e.id
        join jobs j on j.batch_id = g.batch_id
        join job_types jt on jt.id = j.job_type_id
        join runs r on r.job_id = j.id
        where r.attempt = (select max(l.attempt) from runs l where l.job_id = j.id)
      )`
    const gateRows = await sql<GateRow>`
      with ${ended},
      per_gate as (
        select gate_id, count(*) as checks, count(*) filter (where cached_from_run_id is not null) as cached
        from checks group by gate_id
      )
      select
        to_char(g.local_period, 'YYYY-MM-DD') as period,
        g.key as gate,
        count(*) as gates,
        count(*) filter (where g.state = 'passed') as passed,
        count(*) filter (where g.state = 'failed') as failed,
        count(*) filter (where g.state = 'cancelled') as cancelled,
        coalesce(sum(pg.checks), 0) as checks,
        coalesce(sum(pg.cached), 0) as cached,
        ${p(0.5)} as wall_p50,
        ${p(0.9)} as wall_p90
      from ended g left join per_gate pg on pg.gate_id = g.id
      group by g.local_period, g.key
      order by g.local_period, g.key`.execute(trx)
    const checkRows = await sql<CheckRow>`
      with ${ended}
      select
        to_char(local_period, 'YYYY-MM-DD') as period,
        job_type,
        count(*) as checks,
        count(*) filter (where run_state = 'failed' and failure_class = 'check_red') as red,
        count(*) filter (where run_state = 'failed') as failed,
        count(*) filter (where cached_from_run_id is not null) as cached
      from checks
      group by local_period, job_type
      order by local_period, job_type`.execute(trx)
    return {
      gates: gateRows.rows.map((r) => {
        const passed = Number(r.passed)
        const failed = Number(r.failed)
        const checks = Number(r.checks)
        return {
          period: r.period,
          gate: r.gate,
          gates: Number(r.gates),
          passed,
          failed,
          cancelled: Number(r.cancelled),
          passRate: passed + failed === 0 ? null : passed / (passed + failed),
          cacheHitShare: checks === 0 ? null : Number(r.cached) / checks,
          wallP50Ms: round(r.wall_p50),
          wallP90Ms: round(r.wall_p90),
        }
      }),
      checks: checkRows.rows.map((r) => ({
        period: r.period,
        jobType: r.job_type,
        checks: Number(r.checks),
        red: Number(r.red),
        failed: Number(r.failed),
        cached: Number(r.cached),
      })),
    }
  })
}
