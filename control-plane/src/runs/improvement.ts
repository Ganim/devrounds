import { sql } from 'kysely'
import type { FailureClass } from '../db/schema.ts'
import { fail } from '../errors/error.ts'
import { findProject, run, type TenantCtx } from '../planning/resolve.ts'

// Thresholds of the daily report (plan §6 and Ruling 11). The day is compared with the 7 local days before it.
export const BASELINE_DAYS = 7
// A step grew when its p50 on the day is more than 20 % and more than 10 s over its p50 of the days before, each side
// with at least 3 samples (fewer say more about noise than about the step).
export const STEP_GROWTH_SHARE = 0.2
export const STEP_GROWTH_MS = 10_000
export const STEP_MIN_SAMPLES = 3
// A failure class doubled when its count on the day is at least 2 and at least twice its daily mean of the days before.
export const CLASS_MIN = 2
export const CLASS_FACTOR = 2
// Retries the same way, from at least 3 on the day.
export const RETRIES_MIN = 3
export const RETRIES_FACTOR = 2
// Failed runs of the day whose class is unclassified, above this share: a classifier rule is missing.
export const UNCLASSIFIED_SHARE = 0.05
export const SLOWEST_STEPS = 5

export type FindingKind = 'step_growth' | 'class_doubled' | 'retries_doubled' | 'unclassified_share'

// sourceKey names the finding across days, so a finding reported again while its task is open opens nothing new
// (planning/findings.ts).
export type Finding = { sourceKey: string; kind: FindingKind; title: string; evidence: string }

export type ImprovementReport = {
  day: string // local YYYY-MM-DD in the tenant time zone
  timeZone: string
  slowestSteps: { jobType: string; step: string; p50Ms: number; runs: number }[]
  retries: { jobType: string; retries: number; baselineDailyMean: number }[]
  // Unclassified / failed runs of the day; null when none failed.
  unclassifiedShare: number | null
  findings: Finding[]
}

type StepRow = {
  job_type: string
  step: string
  day_p50: number | null
  day_runs: string
  base_p50: number | null
  base_runs: string
}
type CountRow = { job_type: string; failure_class: FailureClass | null; day_n: string; base_n: string }

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/

function checkDay(day: string): void {
  const m = DAY.exec(day)
  const date = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null
  // Date.UTC rolls 2026-02-31 over into March; reading the day back catches it.
  if (!m || !date || date.toISOString().slice(0, 10) !== day) {
    fail('DR101', { path: '/day', reason: 'expected a calendar date YYYY-MM-DD' })
  }
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`
const percent = (share: number) => `${Math.round(share * 100)} %`

/**
 * What got worse on one local day of the tenant (default: yesterday) against the 7 local days before it: steps whose
 * p50 grew, failure classes and retries that doubled, and the share of failures nobody classified. Runs count by
 * the local day they finished; cache hits ran nothing and skipped runs never started, so both are left out.
 * Steps are run_steps durations of finished steps; a job type that reported no step in the window is measured on
 * the run time of its finished runs, as step `run`.
 */
export async function improvementReport(ctx: TenantCtx, projectKey: string, day?: string): Promise<ImprovementReport> {
  if (day !== undefined) checkDay(day)
  return run(ctx, async (trx) => {
    const project = await findProject(trx, projectKey)
    const tenant = await trx
      .selectFrom('tenants')
      .select('timezone')
      .where('id', '=', ctx.tenantId)
      .executeTakeFirstOrThrow()
    const tz = tenant.timezone
    const theDay =
      day ??
      (
        await sql<{ day: string }>`select to_char((now() at time zone ${tz})::date - 1, 'YYYY-MM-DD') as day`.execute(
          trx,
        )
      ).rows[0].day
    // From local midnight BASELINE_DAYS before the day to local midnight after it.
    const ended = sql`
      ended as (
        select r.id, r.state, r.cause, r.failure_class, r.started_at, r.finished_at, jt.key as job_type,
          (r.finished_at at time zone ${tz})::date = ${theDay}::date as on_day
        from runs r join job_types jt on jt.id = r.job_type_id
        where r.project_id = ${project.id}
          and r.finished_at >= ((${theDay}::date - ${BASELINE_DAYS}::int)::timestamp at time zone ${tz})
          and r.finished_at < ((${theDay}::date + 1)::timestamp at time zone ${tz})
          and r.cached_from_run_id is null
          and r.state <> 'skipped'
      )`
    const ms = (from: string, to: string) => sql`(extract(epoch from ${sql.ref(to)} - ${sql.ref(from)}) * 1000)::float8`
    const p50 = (side: unknown) =>
      sql`percentile_cont(0.5::float8) within group (order by ms) filter (where on_day = ${side})`
    const steps = await sql<StepRow>`
      with ${ended},
      stepped as (select distinct e.job_type from ended e join run_steps s on s.run_id = e.id),
      samples as (
        select e.job_type, s.name as step, e.on_day, ${ms('s.started_at', 's.finished_at')} as ms
        from ended e join run_steps s on s.run_id = e.id
        where s.outcome = 'finished' and s.finished_at is not null
        union all
        select e.job_type, 'run', e.on_day, ${ms('e.started_at', 'e.finished_at')}
        from ended e
        where e.state = 'finished' and e.started_at is not null
          and e.job_type not in (select job_type from stepped)
      )
      select job_type, step,
        ${p50(true)} as day_p50, count(*) filter (where on_day) as day_runs,
        ${p50(false)} as base_p50, count(*) filter (where not on_day) as base_runs
      from samples
      group by job_type, step
      order by job_type, step`.execute(trx)
    // One query for both counts: failed runs per class, and retries (failure_class null on those rows).
    const counts = await sql<CountRow>`
      with ${ended}
      select job_type, failure_class,
        count(*) filter (where on_day) as day_n, count(*) filter (where not on_day) as base_n
      from ended where state = 'failed' and failure_class is not null
      group by job_type, failure_class
      union all
      select job_type, null,
        count(*) filter (where on_day), count(*) filter (where not on_day)
      from ended where cause = 'retry'
      group by job_type
      order by job_type, failure_class`.execute(trx)
    return build(theDay, tz, steps.rows, counts.rows)
  })
}

function build(day: string, timeZone: string, steps: StepRow[], counts: CountRow[]): ImprovementReport {
  const findings: Finding[] = []
  for (const s of steps) {
    const [dayRuns, baseRuns] = [Number(s.day_runs), Number(s.base_runs)]
    if (s.day_p50 === null || s.base_p50 === null) continue
    if (dayRuns < STEP_MIN_SAMPLES || baseRuns < STEP_MIN_SAMPLES) continue
    const grew = s.day_p50 - s.base_p50
    if (grew <= STEP_GROWTH_MS || grew <= s.base_p50 * STEP_GROWTH_SHARE) continue
    findings.push({
      sourceKey: `improvement:step:${s.job_type}:${s.step}`,
      kind: 'step_growth',
      title: `Step ${s.step} of ${s.job_type} got slower`,
      evidence:
        `p50 ${seconds(s.day_p50)} over ${dayRuns} runs on ${day} against ${seconds(s.base_p50)} over ${baseRuns} ` +
        `runs in the ${BASELINE_DAYS} days before (+${seconds(grew)}, +${percent(grew / s.base_p50)})`,
    })
  }
  const doubled = (n: number, base: number, min: number, factor: number) =>
    n >= min && n >= (factor * base) / BASELINE_DAYS
  const evidence = (n: number, base: number) =>
    `${n} on ${day} against a daily mean of ${(base / BASELINE_DAYS).toFixed(1)} (${base} over the ` +
    `${BASELINE_DAYS} days before)`
  const retries: ImprovementReport['retries'] = []
  let failed = 0
  let unclassified = 0
  for (const c of counts) {
    const [n, base] = [Number(c.day_n), Number(c.base_n)]
    if (c.failure_class === null) {
      if (n > 0) retries.push({ jobType: c.job_type, retries: n, baselineDailyMean: base / BASELINE_DAYS })
      if (doubled(n, base, RETRIES_MIN, RETRIES_FACTOR)) {
        findings.push({
          sourceKey: `improvement:retries:${c.job_type}`,
          kind: 'retries_doubled',
          title: `${c.job_type} is retried more often`,
          evidence: `retries: ${evidence(n, base)}`,
        })
      }
      continue
    }
    failed += n
    if (c.failure_class === 'unclassified') unclassified += n
    if (doubled(n, base, CLASS_MIN, CLASS_FACTOR)) {
      findings.push({
        sourceKey: `improvement:class:${c.job_type}:${c.failure_class}`,
        kind: 'class_doubled',
        title: `${c.job_type} fails more often with class ${c.failure_class}`,
        evidence: `${c.failure_class} failures: ${evidence(n, base)}`,
      })
    }
  }
  const unclassifiedShare = failed === 0 ? null : unclassified / failed
  if (unclassifiedShare !== null && unclassifiedShare > UNCLASSIFIED_SHARE) {
    findings.push({
      sourceKey: 'improvement:unclassified',
      kind: 'unclassified_share',
      title: 'Failed runs without a failure class',
      evidence:
        `${unclassified} of ${failed} failed runs on ${day} (${percent(unclassifiedShare)}) are unclassified, ` +
        `above ${percent(UNCLASSIFIED_SHARE)}: a job type lacks a classify rule for them`,
    })
  }
  const slowestSteps = steps
    .filter((s) => s.day_p50 !== null)
    .map((s) => ({ jobType: s.job_type, step: s.step, p50Ms: Math.round(s.day_p50 ?? 0), runs: Number(s.day_runs) }))
    .sort((a, b) => b.p50Ms - a.p50Ms || a.jobType.localeCompare(b.jobType) || a.step.localeCompare(b.step))
    .slice(0, SLOWEST_STEPS)
  return { day, timeZone, slowestSteps, retries, unclassifiedShare, findings }
}
