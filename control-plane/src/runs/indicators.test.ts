import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { putJobType } from '../job-types/service.ts'
import { enqueueRun } from '../jobs/enqueue.ts'
import type { Ctx } from '../planning/resolve.ts'
import { createProject } from '../planning/service.ts'
import { withTenant } from '../tenancy/scope.ts'
import { testDb } from '../test-support/db.ts'
import { indicatorsNow, runIndicators } from './indicators.ts'

const projectKey = 'devrounds'
const MIB = 1024 * 1024
const GIB = 1024 * MIB

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
    waitS?: number
    state?: 'finished' | 'failed' | 'stopped' | 'skipped'
    failureClass?: 'check_red' | 'unclassified' | 'infra'
    cause?: 'first' | 'retry' | 'requeue'
    peak?: number
    cpu?: number
  }
  // Attempts are unique per job; the queued run holds attempt 1.
  let attempt = 1
  // An ended run: queued, offered `waitS` later, admitted 1 s after the offer, started then, finished `runS` later.
  const ended = async (e: Ended) => {
    const job = jobs.get(e.jobType ?? 'check') as { jobId: string; jobTypeId: string; projectId: string }
    const finished = Date.parse(e.finishedAt)
    const started = finished - (e.runS ?? 1) * 1000
    const admitted = started
    const offered = admitted - 1000
    const queued = offered - (e.waitS ?? 1) * 1000
    await t.admin
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
        queued_at: new Date(queued),
        offered_at: new Date(offered),
        admitted_at: new Date(admitted),
        started_at: new Date(started),
        finished_at: new Date(finished),
        peak_private_bytes: e.peak ?? null,
        cpu_seconds: e.cpu ?? null,
      })
      .execute()
  }
  return { t, tenant, ctx, ended }
}

// The local day 2026-11-10 in America/Sao_Paulo.
const DAY_10 = { period: 'day' as const, from: new Date('2026-11-10T03:00:00Z'), to: new Date('2026-11-11T02:59:59Z') }

test('p50 and p90 of queue wait and run time per job type per local day', async () => {
  const { ctx, ended } = await setup()
  for (let i = 1; i <= 10; i++) {
    await ended({
      finishedAt: `2026-11-10T15:${String(i).padStart(2, '0')}:00Z`,
      runS: i,
      waitS: 2 * i,
      peak: i * MIB,
      cpu: i / 2,
    })
  }
  await ended({ jobType: 'lint', finishedAt: '2026-11-10T16:00:00Z', runS: 3 })

  const rows = await runIndicators(ctx, projectKey, DAY_10)
  assert.deepEqual(rows, [
    {
      period: '2026-11-10',
      jobType: 'check',
      runs: 10,
      finished: 10,
      failed: 0,
      skipped: 0,
      failureClasses: {},
      retries: 0,
      requeues: 0,
      queueWaitP50Ms: 11000,
      queueWaitP90Ms: 18200,
      admissionDelayP50Ms: 1000,
      runTimeP50Ms: 5500,
      runTimeP90Ms: 9100,
      peakP50Bytes: 5.5 * MIB,
      peakMaxBytes: 10 * MIB,
      cpuSeconds: 27.5,
    },
    {
      period: '2026-11-10',
      jobType: 'lint',
      runs: 1,
      finished: 1,
      failed: 0,
      skipped: 0,
      failureClasses: {},
      retries: 0,
      requeues: 0,
      queueWaitP50Ms: 1000,
      queueWaitP90Ms: 1000,
      admissionDelayP50Ms: 1000,
      runTimeP50Ms: 3000,
      runTimeP90Ms: 3000,
      // No run of lint reported memory or CPU.
      peakP50Bytes: null,
      peakMaxBytes: null,
      cpuSeconds: null,
    },
  ])
})

test('a run finished at 02:30Z counts on the previous day in America/Sao_Paulo', async () => {
  const { ctx, ended } = await setup()
  await ended({ finishedAt: '2026-11-11T02:30:00Z' }) // 23:30 local on the 10th
  await ended({ finishedAt: '2026-11-11T03:30:00Z' }) // 00:30 local on the 11th
  await ended({ finishedAt: '2026-11-09T02:59:00Z' }) // 23:59 local on the 8th, before the window

  const window = { from: new Date('2026-11-09T12:00:00Z'), to: new Date('2026-11-11T12:00:00Z') }
  const days = await runIndicators(ctx, projectKey, { period: 'day', ...window })
  assert.deepEqual(
    days.map((r) => [r.period, r.runs]),
    [
      ['2026-11-10', 1],
      ['2026-11-11', 1],
    ],
  )
  // Weeks start on Monday: the 10th and the 11th fall in the week of Monday the 9th, the 8th (a Sunday) does not.
  const weeks = await runIndicators(ctx, projectKey, { period: 'week', ...window })
  assert.deepEqual(
    weeks.map((r) => [r.period, r.runs]),
    [['2026-11-09', 2]],
  )
})

test('failure classes include unclassified', async () => {
  const { ctx, ended } = await setup()
  await ended({ finishedAt: '2026-11-10T15:00:00Z', state: 'failed', failureClass: 'check_red' })
  await ended({ finishedAt: '2026-11-10T15:01:00Z', state: 'failed', failureClass: 'unclassified' })
  await ended({ finishedAt: '2026-11-10T15:02:00Z', state: 'failed', failureClass: 'unclassified' })
  await ended({ finishedAt: '2026-11-10T15:03:00Z', state: 'skipped' })
  await ended({ finishedAt: '2026-11-10T15:04:00Z' })

  const [row] = await runIndicators(ctx, projectKey, DAY_10)
  assert.deepEqual(
    [row.runs, row.finished, row.failed, row.skipped, row.failureClasses],
    [5, 1, 3, 1, { check_red: 1, unclassified: 2 }],
  )
})

test('retries and requeues are counted by cause', async () => {
  const { ctx, ended } = await setup()
  await ended({ finishedAt: '2026-11-10T15:00:00Z', state: 'failed', failureClass: 'infra' })
  await ended({ finishedAt: '2026-11-10T15:01:00Z', cause: 'requeue' })
  await ended({ finishedAt: '2026-11-10T15:02:00Z', cause: 'retry', state: 'failed', failureClass: 'check_red' })
  await ended({ finishedAt: '2026-11-10T15:03:00Z', cause: 'retry' })

  const [row] = await runIndicators(ctx, projectKey, DAY_10)
  assert.deepEqual([row.runs, row.retries, row.requeues], [4, 2, 1])
})

test('now reports the oldest wait per queue and reserved vs free per machine', async () => {
  const { t, tenant, ctx } = await setup()
  const machine = await withTenant(t.db, tenant.tenantId, (trx) =>
    trx
      .insertInto('machines')
      .values({
        tenant_id: tenant.tenantId,
        name: 'build-01',
        token_hash: randomBytes(32),
        os: 'windows',
        executor_version: '0.1.0',
        last_report: JSON.stringify({ total_memory: 16 * GIB, available_memory: 8 * GIB }),
      })
      .returning('id')
      .executeTakeFirstOrThrow(),
  )
  // Of the two queued runs (check, lint), lint was queued a minute ago; check is offered on build-01 with 1 GiB.
  const runs = await t.admin
    .selectFrom('runs')
    .select(['id', 'job_type_id'])
    .where('tenant_id', '=', tenant.tenantId)
    .execute()
  const [checkType, lintType] = await Promise.all(
    ['check', 'lint'].map((key) =>
      t.admin
        .selectFrom('job_types')
        .select(['id', 'project_id'])
        .where('tenant_id', '=', tenant.tenantId)
        .where('key', '=', key)
        .executeTakeFirstOrThrow(),
    ),
  )
  const checkRun = runs.find((r) => r.job_type_id === checkType.id)?.id as string
  const lintRun = runs.find((r) => r.job_type_id === lintType.id)?.id as string
  await t.admin
    .updateTable('runs')
    .set({ state: 'offered', machine_id: machine.id, memory_need: String(GIB) })
    .where('id', '=', checkRun)
    .execute()
  await t.admin
    .updateTable('runs')
    .set({ queued_at: new Date(Date.now() - 60_000) })
    .where('id', '=', lintRun)
    .execute()
  await t.admin
    .insertInto('learned_needs')
    .values({
      tenant_id: tenant.tenantId,
      project_id: checkType.project_id,
      job_type_id: checkType.id,
      machine_id: machine.id,
      need_bytes: String(700 * MIB),
      samples: 4,
    })
    .execute()

  const now = await indicatorsNow(ctx, projectKey)
  assert.equal(now.queues.length, 1)
  const [queue] = now.queues
  assert.deepEqual([queue.key, queue.depth], ['default', 1])
  assert.ok(
    queue.oldestWaitMs !== null && queue.oldestWaitMs >= 60_000 && queue.oldestWaitMs < 70_000,
    String(queue.oldestWaitMs),
  )
  assert.deepEqual(now.machines, [
    { name: 'build-01', freeBytes: 8 * GIB, reservedBytes: GIB, reserveBytes: Math.floor((16 * GIB) / 10) },
  ])
  assert.deepEqual(now.learnedNeeds, [{ jobType: 'check', machine: 'build-01', needBytes: 700 * MIB, samples: 4 }])
})

test("another tenant's runs are not counted", async () => {
  const mine = await setup()
  const theirs = await setup()
  await mine.ended({ finishedAt: '2026-11-10T15:00:00Z' })
  await theirs.ended({ finishedAt: '2026-11-10T15:00:00Z' })
  await theirs.ended({ finishedAt: '2026-11-10T15:01:00Z' })

  const rows = await runIndicators(mine.ctx, projectKey, DAY_10)
  assert.deepEqual(
    rows.map((r) => [r.jobType, r.runs]),
    [['check', 1]],
  )
})
