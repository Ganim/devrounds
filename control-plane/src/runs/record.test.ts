import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { DevRoundsError } from '../errors/error.ts'
import type { RunEvent } from '../executor/protocol.ts'
import { putJobType } from '../job-types/service.ts'
import type { Ctx } from '../planning/resolve.ts'
import { addTask, createProject } from '../planning/service.ts'
import { withTenant } from '../tenancy/scope.ts'
import { testDb } from '../test-support/db.ts'
import { DEFAULT_MEMORY_NEED, learnedNeed } from './learned-need.ts'
import { applyRunEvent, createRun, markOffered, retryRun } from './record.ts'
import { runView } from './view.ts'

const projectKey = 'devrounds'
const SECOND = 1000
const MIB = 1024 * 1024

const code = (expected: string) => (err: unknown) => err instanceof DevRoundsError && err.code === expected

async function setup() {
  const t = await testDb()
  const tenant = await t.newTenant()
  const ctx: Ctx = { db: t.db, tenantId: tenant.tenantId, actor: { id: tenant.human.id, kind: 'human' } }
  await createProject(ctx, { key: projectKey, name: 'DevRounds' })
  await addTask(ctx, { projectKey, key: 'P1-T38', title: 'Run record' })
  const machineId = await withTenant(t.db, tenant.tenantId, async (trx) => {
    const row = await trx
      .insertInto('machines')
      .values({
        tenant_id: tenant.tenantId,
        name: 'build-01',
        token_hash: randomBytes(32),
        os: 'windows',
        executor_version: '0.1.0',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return row.id
  })
  await putJobType(ctx, projectKey, {
    key: 'check',
    command: { program: 'pnpm', args: ['check'] },
    env: ['PATH'],
    timeout_s: 600,
    orphan_policy: 'kill',
    classify: [{ class: 'check_red', exit_codes: [1] }],
  })
  const start = () => createRun(ctx, { projectKey, jobTypeKey: 'check', machineName: 'build-01', cwd: 'C:\\work' })
  return { t, tenant, ctx, machineId, start }
}

async function offeredAt(t: Awaited<ReturnType<typeof testDb>>, runId: string): Promise<Date> {
  const row = await t.admin.selectFrom('runs').select('offered_at').where('id', '=', runId).executeTakeFirstOrThrow()
  return row.offered_at as Date
}

const finished = (run: string, exitCode: number, peak = 200 * MIB): Extract<RunEvent, { kind: 'RunFinished' }> => ({
  kind: 'RunFinished',
  run,
  reason: 'exited',
  exit_code: exitCode,
  peak,
  p95: 150 * MIB,
  p50: 100 * MIB,
  cpu_seconds: 12.5,
  swept: 0,
  visible_windows: 0,
  tail: ['ok'],
  summary: null,
})

const later = (base: Date, ms: number) => new Date(base.getTime() + ms)

test('a run moves queued → offered → admitted → running → finished and stamps each time', async () => {
  const { t, ctx, machineId, start } = await setup()
  const created = await start()
  assert.equal(created.state, 'queued')
  assert.equal(created.attempt, 1)
  assert.equal(created.jobType, 'check')
  assert.equal(created.machine, 'build-01')
  assert.equal(created.timeline.offeredAt, null)
  assert.equal(created.durations.totalMs, null)

  await markOffered(ctx, created.id)
  const offered = await offeredAt(t, created.id)
  await applyRunEvent(ctx, machineId, { kind: 'Admitted', run: created.id }, later(offered, SECOND))
  await applyRunEvent(
    ctx,
    machineId,
    { kind: 'RunStarted', run: created.id, pid: 4242, start_time: '133768000000000000', boot_id: 'boot-1' },
    later(offered, 2 * SECOND),
  )
  const running = await runView(ctx, created.id)
  assert.equal(running.state, 'running')
  assert.equal(running.durations.runTimeMs, null)

  await applyRunEvent(ctx, machineId, finished(created.id, 0), later(offered, 12 * SECOND))
  const view = await runView(ctx, created.id)
  assert.equal(view.state, 'finished')
  assert.deepEqual(view.timeline, {
    queuedAt: created.timeline.queuedAt,
    offeredAt: offered,
    admittedAt: later(offered, SECOND),
    startedAt: later(offered, 2 * SECOND),
    finishedAt: later(offered, 12 * SECOND),
  })
  assert.equal(view.durations.admissionDelayMs, SECOND)
  assert.equal(view.durations.runTimeMs, 10 * SECOND)
  assert.equal(view.durations.totalMs, view.timeline.finishedAt.getTime() - view.timeline.queuedAt.getTime())
  assert.ok((view.durations.queueWaitMs ?? -1) >= 0)
  assert.deepEqual(view.outcome, { exitCode: 0, failureClass: null, failureSummary: null, logCursor: null })
  assert.deepEqual(view.resources, {
    peak: 200 * MIB,
    p95: 150 * MIB,
    p50: 100 * MIB,
    cpuSeconds: 12.5,
    swept: 0,
    visibleWindows: 0,
  })
  const identity = await t.admin
    .selectFrom('runs')
    .select(['pid', 'process_start_time', 'boot_id'])
    .where('id', '=', created.id)
    .executeTakeFirstOrThrow()
  assert.deepEqual(identity, { pid: 4242, process_start_time: '133768000000000000', boot_id: 'boot-1' })
})

test('a failed exit is classified by the job type rules', async () => {
  const { ctx, machineId, start } = await setup()
  const created = await start()
  await markOffered(ctx, created.id)
  const at = new Date(Date.now() + SECOND)
  await applyRunEvent(ctx, machineId, { kind: 'Admitted', run: created.id }, at)
  await applyRunEvent(
    ctx,
    machineId,
    { kind: 'RunStarted', run: created.id, pid: 1, start_time: '1', boot_id: 'b' },
    at,
  )
  await applyRunEvent(ctx, machineId, finished(created.id, 1), at)
  const view = await runView(ctx, created.id)
  assert.equal(view.state, 'failed')
  assert.deepEqual(view.outcome, { exitCode: 1, failureClass: 'check_red', failureSummary: 'ok', logCursor: null })
})

test('an illegal transition answers DR351 and changes nothing', async () => {
  const { t, ctx, machineId, start } = await setup()
  const created = await start()
  const event: RunEvent = { kind: 'RunStarted', run: created.id, pid: 1, start_time: '1', boot_id: 'b' }
  await assert.rejects(applyRunEvent(ctx, machineId, event, new Date()), (err: unknown) => {
    assert.ok(err instanceof DevRoundsError && err.code === 'DR351')
    assert.deepEqual(err.data, { run: created.id, state: 'queued' })
    return true
  })
  const row = await t.admin.selectFrom('runs').selectAll().where('id', '=', created.id).executeTakeFirstOrThrow()
  assert.equal(row.state, 'queued')
  assert.equal(row.pid, null)
  assert.equal(row.started_at, null)

  await markOffered(ctx, created.id)
  await assert.rejects(markOffered(ctx, created.id), code('DR351'))
})

test('durations are never negative when the executor clock is behind', async () => {
  const { t, ctx, machineId, start } = await setup()
  const created = await start()
  await markOffered(ctx, created.id)
  const offered = await offeredAt(t, created.id)
  // Both executor stamps are 5 s before the control plane's offer; without the clamp admission would be -5000 ms.
  await applyRunEvent(ctx, machineId, { kind: 'Admitted', run: created.id }, later(offered, -5 * SECOND))
  await applyRunEvent(
    ctx,
    machineId,
    { kind: 'RunStarted', run: created.id, pid: 1, start_time: '1', boot_id: 'b' },
    later(offered, -5 * SECOND),
  )
  const view = await runView(ctx, created.id)
  assert.equal(view.durations.admissionDelayMs, 0)
  assert.deepEqual(view.timeline.admittedAt, offered)
  assert.deepEqual(view.timeline.startedAt, offered)
  const row = await t.admin
    .selectFrom('runs')
    .select('clock_skew_ms')
    .where('id', '=', created.id)
    .executeTakeFirstOrThrow()
  assert.equal(row.clock_skew_ms, 5000)
})

test('durations are never negative when the executor clock steps back', async () => {
  const { t, ctx, machineId, start } = await setup()
  const created = await start()
  await markOffered(ctx, created.id)
  const offered = await offeredAt(t, created.id)
  const event = (e: RunEvent, ms: number) => applyRunEvent(ctx, machineId, e, later(offered, ms))
  await event({ kind: 'Admitted', run: created.id }, SECOND)
  await event({ kind: 'RunStarted', run: created.id, pid: 1, start_time: '1', boot_id: 'b' }, 5 * SECOND)
  await event({ kind: 'StepStarted', run: created.id, step: 1, name: 'build' }, 6 * SECOND)
  await event({ kind: 'StepFinished', run: created.id, step: 1, outcome: 'finished' }, 4 * SECOND)
  await event(finished(created.id, 0), 3 * SECOND)

  const view = await runView(ctx, created.id)
  assert.ok((view.durations.runTimeMs ?? -1) >= 0, `runTimeMs ${view.durations.runTimeMs}`)
  for (const step of view.steps) {
    assert.ok((step.finishedAt?.getTime() ?? 0) - step.startedAt.getTime() >= 0, `step ${step.step}`)
  }
  assert.deepEqual(view.timeline.finishedAt, later(offered, 6 * SECOND))
  const row = await t.admin
    .selectFrom('runs')
    .select('clock_skew_ms')
    .where('id', '=', created.id)
    .executeTakeFirstOrThrow()
  assert.equal(row.clock_skew_ms, 3000)
})

test('a step that starts twice answers DR351', async () => {
  const { ctx, machineId, start } = await setup()
  const created = await start()
  await markOffered(ctx, created.id)
  const at = new Date(Date.now() + SECOND)
  await applyRunEvent(ctx, machineId, { kind: 'Admitted', run: created.id }, at)
  await applyRunEvent(
    ctx,
    machineId,
    { kind: 'RunStarted', run: created.id, pid: 1, start_time: '1', boot_id: 'b' },
    at,
  )
  const step: RunEvent = { kind: 'StepStarted', run: created.id, step: 1, name: 'build' }
  await applyRunEvent(ctx, machineId, step, at)
  await assert.rejects(applyRunEvent(ctx, machineId, step, at), code('DR351'))
})

test('a retry is a new run of the same job with attempt 2', async () => {
  const { t, ctx, machineId, start } = await setup()
  const created = await start()
  await assert.rejects(retryRun(ctx, created.id), code('DR351'))
  await markOffered(ctx, created.id)
  await applyRunEvent(
    ctx,
    machineId,
    { ...finished(created.id, 0), reason: 'spawn_failed', exit_code: null, summary: 'no pnpm' },
    new Date(Date.now() + SECOND),
  )

  const retry = await retryRun(ctx, created.id)
  assert.notEqual(retry.id, created.id)
  assert.equal(retry.attempt, 2)
  assert.equal(retry.state, 'queued')
  assert.equal(retry.machine, 'build-01')
  const rows = await t.admin
    .selectFrom('runs')
    .select(['job_id', 'attempt', 'machine_id'])
    .where('id', 'in', [created.id, retry.id])
    .orderBy('attempt')
    .execute()
  assert.equal(rows[0].job_id, rows[1].job_id)
  assert.equal(rows[1].machine_id, machineId)
})

test('steps and delays are recorded with the run', async () => {
  const { ctx, machineId, start } = await setup()
  const created = await start()
  await markOffered(ctx, created.id)
  const at = new Date(Date.now() + SECOND)
  const event = (e: RunEvent, ms: number) => applyRunEvent(ctx, machineId, e, later(at, ms))
  await event(
    { kind: 'Delayed', run: created.id, reason: 'memory', position: 2, need: 512 * MIB, available: 100 * MIB },
    0,
  )
  await event(
    { kind: 'Delayed', run: created.id, reason: 'concurrency', position: 1, need: 512 * MIB, available: null },
    100,
  )
  await event({ kind: 'Admitted', run: created.id }, 200)
  await event({ kind: 'RunStarted', run: created.id, pid: 1, start_time: '1', boot_id: 'b' }, 300)
  await event({ kind: 'StepStarted', run: created.id, step: 1, name: 'build' }, 400)
  await event({ kind: 'StepFinished', run: created.id, step: 1, outcome: 'finished' }, 500)
  await event({ kind: 'StepStarted', run: created.id, step: 2, name: 'test' }, 600)

  const view = await runView(ctx, created.id)
  assert.deepEqual(view.delays, [
    { at: later(at, 0), reason: 'memory', needBytes: 512 * MIB, availableBytes: 100 * MIB, position: 2 },
    { at: later(at, 100), reason: 'concurrency', needBytes: 512 * MIB, availableBytes: null, position: 1 },
  ])
  assert.deepEqual(view.steps, [
    { step: 1, name: 'build', startedAt: later(at, 400), finishedAt: later(at, 500), outcome: 'finished' },
    { step: 2, name: 'test', startedAt: later(at, 600), finishedAt: null, outcome: null },
  ])
})

test('learned need is the median of the last 10 peaks, 536870912 without history', async () => {
  const { t, tenant, ctx, machineId, start } = await setup()
  const ids = async () =>
    withTenant(t.db, tenant.tenantId, (trx) =>
      trx.selectFrom('job_types').select(['id', 'project_id']).where('key', '=', 'check').executeTakeFirstOrThrow(),
    )
  const jobType = await ids()
  const need = () =>
    withTenant(t.db, tenant.tenantId, (trx) => learnedNeed(trx, jobType.project_id, jobType.id, machineId))
  assert.equal(await need(), 536870912n)
  assert.equal(DEFAULT_MEMORY_NEED, 536870912n)

  // 12 runs; the two oldest (huge) fall out of the window, leaving peaks 1..10 MiB: median = 5.5 MiB.
  const peaks = [1000, 1000, 3, 1, 4, 10, 5, 9, 2, 6, 8, 7].map((mib) => mib * MIB)
  const base = Date.now() + SECOND
  for (const [i, peak] of peaks.entries()) {
    const created = await start()
    await markOffered(ctx, created.id)
    const at = later(new Date(base), i * SECOND)
    await applyRunEvent(ctx, machineId, { kind: 'Admitted', run: created.id }, at)
    await applyRunEvent(
      ctx,
      machineId,
      { kind: 'RunStarted', run: created.id, pid: 1, start_time: '1', boot_id: 'b' },
      at,
    )
    await applyRunEvent(ctx, machineId, finished(created.id, 0, peak), at)
  }
  // A run without a peak does not count.
  await start()
  assert.equal(await need(), BigInt(5.5 * MIB))
})

test('a run of another tenant is not found (DR201)', async () => {
  const a = await setup()
  const b = await setup()
  const created = await a.start()
  await assert.rejects(runView(b.ctx, created.id), (err: unknown) => {
    assert.ok(err instanceof DevRoundsError && err.code === 'DR201')
    assert.deepEqual(err.data, { kind: 'run', key: created.id })
    return true
  })
  await assert.rejects(markOffered(b.ctx, created.id), code('DR201'))
  await assert.rejects(retryRun(b.ctx, created.id), code('DR201'))
  await assert.rejects(
    applyRunEvent(b.ctx, b.machineId, { kind: 'Admitted', run: created.id }, new Date()),
    code('DR201'),
  )
  // Same tenant, another machine: the executor only reports its own runs.
  await markOffered(a.ctx, created.id)
  const other = await withTenant(a.t.db, a.tenant.tenantId, async (trx) => {
    const row = await trx
      .insertInto('machines')
      .values({
        tenant_id: a.tenant.tenantId,
        name: 'build-02',
        token_hash: randomBytes(32),
        os: 'windows',
        executor_version: '0.1.0',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return row.id
  })
  await assert.rejects(applyRunEvent(a.ctx, other, { kind: 'Admitted', run: created.id }, new Date()), code('DR201'))
  await assert.rejects(runView(a.ctx, 'not-a-uuid'), code('DR201'))
})

test('a run for a task records the task key', async () => {
  const { ctx } = await setup()
  const view = await createRun(ctx, {
    projectKey,
    jobTypeKey: 'check',
    machineName: 'build-01',
    cwd: 'C:\\work',
    taskKey: 'P1-T38',
  })
  assert.equal(view.task, 'P1-T38')
  await assert.rejects(
    createRun(ctx, { projectKey, jobTypeKey: 'missing', machineName: 'build-01', cwd: 'C:\\work' }),
    (err: unknown) => err instanceof DevRoundsError && err.code === 'DR201' && err.data.kind === 'job type',
  )
})
