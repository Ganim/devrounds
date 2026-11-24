import assert from 'node:assert/strict'
import { test } from 'node:test'
import { putJobType } from '../job-types/service.ts'
import { enqueueRun } from '../jobs/enqueue.ts'
import type { Ctx } from '../planning/resolve.ts'
import { createProject } from '../planning/service.ts'
import { testDb } from '../test-support/db.ts'
import { improvementReport } from './improvement.ts'

const projectKey = 'devrounds'
const DAY = '2026-11-10'

// A tenant in America/Sao_Paulo (UTC-3, no DST since 2019) with project `devrounds` and job types `check` and `lint`.
// One queued run per job type gives the job each ended run below hangs off; queued runs never count as ended.
async function setup() {
  const t = await testDb()
  const tenant = await t.newTenant()
  await t.admin
    .updateTable('tenants')
    .set({ timezone: 'America/Sao_Paulo' })
    .where('id', '=', tenant.tenantId)
    .execute()
  const ctx: Ctx = { db: t.db, tenantId: tenant.tenantId, actor: { id: tenant.human.id, kind: 'human' } }
  await createProject(ctx, { key: projectKey, name: 'DevRounds' })
  const jobs = new Map<string, { jobId: string; jobTypeId: string; projectId: string }>()
  for (const key of ['check', 'lint']) {
    await putJobType(ctx, projectKey, { key, command: { program: 'pnpm', args: [key] } })
    const queued = await enqueueRun(ctx, { projectKey, jobTypeKey: key, cwd: 'C:\\work' })
    const row = await t.admin
      .selectFrom('runs')
      .select(['job_id', 'job_type_id', 'project_id'])
      .where('id', '=', queued.id)
      .executeTakeFirstOrThrow()
    jobs.set(key, { jobId: row.job_id, jobTypeId: row.job_type_id, projectId: row.project_id })
  }

  type Ended = {
    jobType?: string
    finishedAt: string
    runS?: number
    state?: 'finished' | 'failed' | 'stopped' | 'skipped'
    failureClass?: 'check_red' | 'unclassified' | 'infra'
    cause?: 'first' | 'retry'
    cachedFrom?: string
    // Steps back to back from the start of the run, each `s` seconds and finished.
    steps?: { name: string; s: number }[]
  }
  let attempt = 1
  const ended = async (e: Ended) => {
    const job = jobs.get(e.jobType ?? 'check') as { jobId: string; jobTypeId: string; projectId: string }
    const finished = Date.parse(e.finishedAt)
    const runS = e.runS ?? e.steps?.reduce((sum, s) => sum + s.s, 0) ?? 1
    const started = finished - runS * 1000
    const row = await t.admin
      .insertInto('runs')
      .values({
        tenant_id: tenant.tenantId,
        project_id: job.projectId,
        job_id: job.jobId,
        job_type_id: job.jobTypeId,
        attempt: ++attempt,
        state: e.state ?? 'finished',
        cause: e.cause ?? 'first',
        failure_class: e.failureClass ?? null,
        queued_at: new Date(started - 2000),
        not_before: new Date(started - 2000),
        offered_at: new Date(started - 1000),
        admitted_at: new Date(started),
        started_at: new Date(started),
        finished_at: new Date(finished),
        cached_from_run_id: e.cachedFrom ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    let at = started
    for (const [i, s] of (e.steps ?? []).entries()) {
      await t.admin
        .insertInto('run_steps')
        .values({
          tenant_id: tenant.tenantId,
          run_id: row.id,
          step: i + 1,
          name: s.name,
          started_at: new Date(at),
          finished_at: new Date(at + s.s * 1000),
          outcome: 'finished',
        })
        .execute()
      at += s.s * 1000
    }
    return row.id
  }
  // `n` runs on one local day (noon UTC is 09:00 there), one per minute.
  const many = async (n: number, day: string, e: Omit<Ended, 'finishedAt'>) => {
    for (let i = 0; i < n; i++) await ended({ ...e, finishedAt: `${day}T12:${String(i).padStart(2, '0')}:00Z` })
  }
  return { ctx, ended, many }
}

const BEFORE = ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09']

test('a step whose p50 grew 25 % and 12 s is a step_growth finding', async () => {
  const { ctx, many } = await setup()
  await many(3, '2026-11-05', { steps: [{ name: 'build', s: 48 }] })
  await many(3, DAY, { steps: [{ name: 'build', s: 60 }] })

  const report = await improvementReport(ctx, projectKey, DAY)

  assert.equal(report.day, DAY)
  assert.equal(report.timeZone, 'America/Sao_Paulo')
  assert.deepEqual(report.slowestSteps, [{ jobType: 'check', step: 'build', p50Ms: 60000, runs: 3 }])
  assert.deepEqual(
    report.findings.map((f) => [f.kind, f.sourceKey]),
    [['step_growth', 'improvement:step:check:build']],
  )
  assert.match(report.findings[0].evidence, /60\.0 s over 3 runs on 2026-11-10 against 48\.0 s over 3 runs/)
})

test('30 % but 5 s, or 15 s but 10 %, is none', async () => {
  const { ctx, many } = await setup()
  await many(3, '2026-11-06', {
    steps: [
      { name: 'small', s: 16 },
      { name: 'large', s: 150 },
    ],
  })
  await many(3, DAY, {
    steps: [
      { name: 'small', s: 21 },
      { name: 'large', s: 165 },
    ],
  })

  const report = await improvementReport(ctx, projectKey, DAY)

  assert.deepEqual(report.findings, [])
  assert.deepEqual(
    report.slowestSteps.map((s) => s.step),
    ['large', 'small'],
  )
})

test('two samples on either side are not compared', async () => {
  const { ctx, many } = await setup()
  // `few-before`: 2 samples before, 3 on the day; `few-on-day`: 3 before, 2 on the day. Both tripled.
  await many(2, '2026-11-07', { steps: [{ name: 'few-before', s: 20 }] })
  await many(3, '2026-11-08', { steps: [{ name: 'few-on-day', s: 20 }] })
  await many(3, DAY, { steps: [{ name: 'few-before', s: 60 }] })
  await many(2, DAY, { steps: [{ name: 'few-on-day', s: 60 }] })

  const report = await improvementReport(ctx, projectKey, DAY)

  assert.deepEqual(report.findings, [])
})

test('a job type without steps is compared on step run', async () => {
  const { ctx, many } = await setup()
  await many(3, '2026-11-04', { runS: 48 })
  await many(3, DAY, { runS: 60 })

  const report = await improvementReport(ctx, projectKey, DAY)

  assert.deepEqual(report.slowestSteps, [{ jobType: 'check', step: 'run', p50Ms: 60000, runs: 3 }])
  assert.deepEqual(
    report.findings.map((f) => f.sourceKey),
    ['improvement:step:check:run'],
  )
})

test('a class seen 4 times on the day against 7 over the 7 days before is doubled, 1 time is not', async () => {
  const { ctx, ended, many } = await setup()
  for (const day of BEFORE) await many(1, day, { state: 'failed', failureClass: 'check_red' })
  await many(4, DAY, { state: 'failed', failureClass: 'check_red' })
  await ended({ jobType: 'lint', finishedAt: `${DAY}T13:00:00Z`, state: 'failed', failureClass: 'infra' })
  // Out of the 7 days before: never part of the mean.
  await many(5, '2026-11-02', { jobType: 'lint', state: 'failed', failureClass: 'infra' })

  const report = await improvementReport(ctx, projectKey, DAY)

  assert.deepEqual(
    report.findings.map((f) => [f.kind, f.sourceKey]),
    [['class_doubled', 'improvement:class:check:check_red']],
  )
  assert.match(report.findings[0].evidence, /4 on 2026-11-10 against a daily mean of 1\.0 \(7 over the 7 days before\)/)
  assert.equal(report.unclassifiedShare, 0)
})

test('1 unclassified of 10 failed is a finding, 0 is none', async () => {
  const { ctx, many } = await setup()
  // 32 failures the day before (a daily mean above 4.5) keep 9 check_red from doubling: only the share can be a finding.
  await many(32, '2026-11-09', { state: 'failed', failureClass: 'check_red' })
  await many(9, DAY, { state: 'failed', failureClass: 'check_red' })
  const none = await improvementReport(ctx, projectKey, DAY)
  await many(1, DAY, { jobType: 'lint', state: 'failed', failureClass: 'unclassified' })

  const one = await improvementReport(ctx, projectKey, DAY)

  assert.equal(none.unclassifiedShare, 0)
  assert.deepEqual(none.findings, [])
  assert.equal(one.unclassifiedShare, 0.1)
  assert.deepEqual(
    one.findings.map((f) => [f.kind, f.sourceKey]),
    [['unclassified_share', 'improvement:unclassified']],
  )
})

test('retries on the day at 2 × the daily mean and at least 3 are a finding', async () => {
  const { ctx, many } = await setup()
  for (const day of BEFORE) await many(1, day, { cause: 'retry' })
  await many(3, DAY, { cause: 'retry' })
  await many(2, DAY, { jobType: 'lint', cause: 'retry' })

  const report = await improvementReport(ctx, projectKey, DAY)

  assert.deepEqual(report.retries, [
    { jobType: 'check', retries: 3, baselineDailyMean: 1 },
    { jobType: 'lint', retries: 2, baselineDailyMean: 0 },
  ])
  assert.deepEqual(
    report.findings.map((f) => [f.kind, f.sourceKey]),
    [['retries_doubled', 'improvement:retries:check']],
  )
})

test('cached and skipped runs are left out', async () => {
  const { ctx, ended, many } = await setup()
  await many(3, '2026-11-05', { runS: 48 })
  const source = await ended({ finishedAt: '2026-11-05T13:00:00Z', runS: 48 })
  await many(3, DAY, { runS: 60 })
  // Were they counted, the p50 of the day would fall under 48 s.
  await many(4, DAY, { runS: 1, cachedFrom: source })
  await many(4, DAY, { runS: 1, state: 'skipped' })

  const report = await improvementReport(ctx, projectKey, DAY)

  assert.deepEqual(report.slowestSteps, [{ jobType: 'check', step: 'run', p50Ms: 60000, runs: 3 }])
  assert.deepEqual(
    report.findings.map((f) => f.sourceKey),
    ['improvement:step:check:run'],
  )
  assert.equal(report.unclassifiedShare, null)
})

test("the day is the tenant's local day", async () => {
  const { ctx, ended } = await setup()
  // 02:30 UTC on the 11th is 23:30 on the 10th in America/Sao_Paulo; 03:30 UTC is 00:30 on the 11th.
  await ended({ finishedAt: '2026-11-11T02:30:00Z', runS: 7 })
  await ended({ finishedAt: '2026-11-11T03:30:00Z', runS: 9 })

  const tenth = await improvementReport(ctx, projectKey, '2026-11-10')
  const eleventh = await improvementReport(ctx, projectKey, '2026-11-11')

  assert.deepEqual(tenth.slowestSteps, [{ jobType: 'check', step: 'run', p50Ms: 7000, runs: 1 }])
  assert.deepEqual(eleventh.slowestSteps, [{ jobType: 'check', step: 'run', p50Ms: 9000, runs: 1 }])
})

test('a day that is not a calendar date is DR101', async () => {
  const { ctx } = await setup()
  for (const day of ['2026-02-31', '2026-11-1', 'yesterday']) {
    await assert.rejects(improvementReport(ctx, projectKey, day), { code: 'DR101' })
  }
})
