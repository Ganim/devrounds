import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { sql } from 'kysely'
import { Sessions } from '../executor/gateway.ts'
import type { RunEvent } from '../executor/protocol.ts'
import type { JobTypeFile } from '../job-types/file.ts'
import { putJobType } from '../job-types/service.ts'
import { revokeMachine } from '../machines/service.ts'
import type { Ctx } from '../planning/resolve.ts'
import { createProject } from '../planning/service.ts'
import { stopRun, waitForRun } from '../runs/dispatch.ts'
import { applyOrphans, applyRunEvent, retryRun } from '../runs/record.ts'
import { claimRun } from '../scheduler/claim.ts'
import { withTenant } from '../tenancy/scope.ts'
import { testDb } from '../test-support/db.ts'
import { enqueueRun, submitBatch } from './enqueue.ts'
import { queueRetry } from './outcome.ts'

const projectKey = 'devrounds'
const PLENTY = 64n * 1024n * 1024n * 1024n

type Retry = JobTypeFile['retry']

// A tenant with project `devrounds`, job type `check` (exit 1 is check_red, retry policy `retry`) and machine
// `build-01`.
async function setup(retry?: Retry) {
  const t = await testDb()
  const tenant = await t.newTenant()
  const ctx: Ctx = { db: t.db, tenantId: tenant.tenantId, actor: { id: tenant.human.id, kind: 'human' } }
  await createProject(ctx, { key: projectKey, name: 'DevRounds' })
  await putJobType(ctx, projectKey, {
    key: 'check',
    command: { program: 'pnpm', args: ['check'] },
    classify: [{ class: 'check_red', exit_codes: [1] }],
    ...(retry === undefined ? {} : { retry }),
  })
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
  const claim = async () =>
    (
      await withTenant(t.db, tenant.tenantId, (trx) =>
        claimRun(trx, machineId, { freeBytes: PLENTY, reserveBytes: 0n, offerTimeoutS: 120 }),
      )
    )?.runId ?? null
  // Offers `runId` on build-01 whatever its not_before, as a claim would once the backoff is over.
  const offer = (runId: string) =>
    t.admin
      .updateTable('runs')
      .set({ state: 'offered', machine_id: machineId, offered_at: sql<Date>`now()` })
      .where('id', '=', runId)
      .where('state', '=', 'queued')
      .execute()
  const event = (e: RunEvent) => applyRunEvent(ctx, machineId, e, new Date())
  const start = async (runId: string) => {
    await event({ kind: 'Admitted', run: runId })
    await event({ kind: 'RunStarted', run: runId, pid: 42, start_time: '1', boot_id: 'boot-1' })
  }
  // Ends an offered run: exit 0 finishes it, exit 1 is check_red, `reason` infra/stopped fail or stop it.
  const end = async (runId: string, how: { exit?: number; reason?: 'exited' | 'infra' | 'stopped' } = {}) => {
    await start(runId)
    await event({
      kind: 'RunFinished',
      run: runId,
      reason: how.reason ?? 'exited',
      exit_code: how.reason === undefined || how.reason === 'exited' ? (how.exit ?? 0) : null,
      peak: 1024,
      p95: 1024,
      p50: 1024,
      cpu_seconds: 1,
      swept: 0,
      visible_windows: 0,
      tail: [],
      summary: null,
    })
  }
  const enqueue = async () => (await enqueueRun(ctx, { projectKey, jobTypeKey: 'check', cwd: 'C:\\work' })).id
  const runsOfJobOf = (runId: string) =>
    t.admin
      .selectFrom('runs')
      .select(['id', 'attempt', 'cause', 'state', 'offered_at', 'failure_summary'])
      .select(
        sql<number>`extract(epoch from not_before - (
        select prev.finished_at from runs prev where prev.job_id = runs.job_id and prev.attempt = runs.attempt - 1
      ))::float8`.as('backoff_s'),
      )
      .where('job_id', '=', t.admin.selectFrom('runs').select('job_id').where('id', '=', runId))
      .orderBy('attempt')
      .execute()
  const jobState = async (runId: string) =>
    (
      await t.admin
        .selectFrom('jobs')
        .select('state')
        .where('id', '=', t.admin.selectFrom('runs').select('job_id').where('id', '=', runId))
        .executeTakeFirstOrThrow()
    ).state
  const batch = (jobs: { ref: string; depends_on?: string[] }[]) =>
    submitBatch(ctx, projectKey, { jobs: jobs.map((job) => ({ ...job, job_type: 'check', cwd: 'C:\\work' })) })
  return { t, ctx, machineId, claim, offer, start, end, enqueue, runsOfJobOf, jobState, batch }
}

// A run of `check` pinned to build-01.
const PINNED = { projectKey, jobTypeKey: 'check', machineName: 'build-01', cwd: 'C:\\work' }

const runOf = (view: { jobs: { ref: string; runId: string }[] }, ref: string) =>
  view.jobs.find((job) => job.ref === ref)?.runId as string

test('a red dependency skips every dependent transitively and none is ever offered', async () => {
  const s = await setup()
  const view = await s.batch([{ ref: 'a' }, { ref: 'b', depends_on: ['a'] }, { ref: 'c', depends_on: ['b'] }])
  assert.equal(await s.claim(), runOf(view, 'a'))
  await s.end(runOf(view, 'a'), { exit: 1 })

  assert.equal(await s.jobState(runOf(view, 'a')), 'failed')
  for (const ref of ['b', 'c']) {
    assert.equal(await s.jobState(runOf(view, ref)), 'skipped', ref)
    const [run] = await s.runsOfJobOf(runOf(view, ref))
    assert.deepEqual(
      [run.state, run.offered_at, run.failure_summary],
      ['skipped', null, 'skipped: dependency a failed'],
    )
  }
  assert.equal(await s.claim(), null)
})

test('a retryable failure queues attempt 2 with not_before 30 s after the end, attempt 3 at 60 s', async () => {
  const s = await setup({ max_attempts: 3 })
  const first = await s.enqueue()
  await s.offer(first)
  await s.end(first, { reason: 'infra' })
  let runs = await s.runsOfJobOf(first)
  assert.deepEqual(
    runs.map((r) => [r.attempt, r.cause, r.state, r.backoff_s]),
    [
      [1, 'first', 'failed', null],
      [2, 'retry', 'queued', 30],
    ],
  )
  assert.equal(await s.jobState(first), 'open')
  // The backoff holds the retry back from the claim.
  assert.equal(await s.claim(), null)

  await s.offer(runs[1].id)
  await s.end(runs[1].id, { reason: 'infra' })
  runs = await s.runsOfJobOf(first)
  assert.deepEqual(
    runs.map((r) => [r.attempt, r.cause, r.state, r.backoff_s]),
    [
      [1, 'first', 'failed', null],
      [2, 'retry', 'failed', 30],
      [3, 'retry', 'queued', 60],
    ],
  )
  assert.equal(await s.jobState(first), 'open')
})

test('check_red is not retried with the default policy', async () => {
  const s = await setup({ max_attempts: 3 })
  const first = await s.enqueue()
  await s.offer(first)
  await s.end(first, { exit: 1 })
  assert.equal((await s.runsOfJobOf(first)).length, 1)
  assert.equal(await s.jobState(first), 'failed')
})

test('retries stop at max_attempts and the job fails', async () => {
  const s = await setup({ max_attempts: 2, backoff_s: 5, on: ['check_red'] })
  const first = await s.enqueue()
  await s.offer(first)
  await s.end(first, { exit: 1 })
  const [, second] = await s.runsOfJobOf(first)
  assert.deepEqual([second.attempt, second.backoff_s], [2, 5])
  await s.offer(second.id)
  await s.end(second.id, { exit: 1 })
  assert.equal((await s.runsOfJobOf(first)).length, 2)
  assert.equal(await s.jobState(first), 'failed')

  // A manual retry goes past max_attempts and opens the job again.
  const manual = await retryRun(s.ctx, second.id)
  assert.deepEqual([manual.attempt, manual.cause], [3, 'retry'])
  assert.equal(await s.jobState(first), 'open')
})

test('a stopped job skips its dependents', async () => {
  const s = await setup()
  const view = await s.batch([{ ref: 'a' }, { ref: 'b', depends_on: ['a'] }])
  assert.equal(await s.claim(), runOf(view, 'a'))
  await s.end(runOf(view, 'a'), { reason: 'stopped' })

  assert.equal(await s.jobState(runOf(view, 'a')), 'stopped')
  assert.equal(await s.jobState(runOf(view, 'b')), 'skipped')
  const [run] = await s.runsOfJobOf(runOf(view, 'b'))
  assert.deepEqual([run.state, run.failure_summary], ['skipped', 'skipped: dependency a stopped'])
})

test('stop of a queued run ends it cancelled without an executor', async () => {
  const s = await setup()
  const view = await s.batch([{ ref: 'a' }, { ref: 'b', depends_on: ['a'] }])
  // No session at all: nothing is sent to any executor.
  const stopped = await stopRun(s.ctx, new Sessions(), runOf(view, 'a'))

  assert.deepEqual(
    [stopped.state, stopped.outcome.failureClass, stopped.machine, stopped.timeline.finishedAt !== null],
    ['stopped', 'cancelled', null, true],
  )
  assert.equal(await s.jobState(runOf(view, 'a')), 'stopped')
  assert.equal(await s.jobState(runOf(view, 'b')), 'skipped')
  assert.equal(await s.claim(), null)
})

test('stop of a queued dependency answers the waiter of its skipped dependent at once', async () => {
  const s = await setup()
  const view = await s.batch([{ ref: 'a' }, { ref: 'b', depends_on: ['a'] }])
  const began = Date.now()
  const waiting = waitForRun(s.ctx, runOf(view, 'b'), 30)
  await stopRun(s.ctx, new Sessions(), runOf(view, 'a'))

  assert.equal((await waiting).state, 'skipped')
  assert.ok(Date.now() - began < 10_000, `took ${Date.now() - began} ms`)
})

test('a finished dependency lets the dependent be claimed', async () => {
  const s = await setup()
  const view = await s.batch([{ ref: 'a' }, { ref: 'b', depends_on: ['a'] }])
  assert.equal(await s.claim(), runOf(view, 'a'))
  assert.equal(await s.claim(), null)
  await s.end(runOf(view, 'a'))

  assert.equal(await s.jobState(runOf(view, 'a')), 'finished')
  assert.equal(await s.claim(), runOf(view, 'b'))
})

test('an orphaned run fails its job without a retry', async () => {
  const s = await setup({ max_attempts: 3 })
  const first = await s.enqueue()
  await s.offer(first)
  await s.start(first)
  await applyOrphans(s.ctx, s.machineId, { kind: 'Orphans', runs: [{ run: first, alive: true }] }, new Date())

  const runs = await s.runsOfJobOf(first)
  assert.deepEqual(
    runs.map((r) => r.state),
    ['orphaned'],
  )
  assert.equal(await s.jobState(first), 'failed')
})

// An offer or admission that never started is the machine's loss, not the job's: like an expired offer, another
// machine may take the job. A job pinned to the revoked machine has nowhere else to go, so it fails once.
test('revoke requeues an unpinned offered run and fails a pinned one once, neither counting as an attempt', async () => {
  const s = await setup({ max_attempts: 3, backoff_s: 0, on: ['infra'] })
  const free = await s.enqueue()
  assert.equal(await s.claim(), free)
  const pinnedView = await submitBatch(s.ctx, projectKey, {
    jobs: [
      { ref: 'p', job_type: 'check', cwd: 'C:\\work', machine: 'build-01' },
      { ref: 'after-p', job_type: 'check', cwd: 'C:\\work', depends_on: ['p'] },
    ],
  })
  const pinned = runOf(pinnedView, 'p')
  assert.equal(await s.claim(), pinned)
  await revokeMachine(s.ctx, 'build-01')

  const freeRuns = await s.runsOfJobOf(free)
  assert.deepEqual(
    freeRuns.map((r) => [r.attempt, r.cause, r.state]),
    [
      [1, 'first', 'stopped'],
      [2, 'requeue', 'queued'],
    ],
  )
  assert.equal(await s.jobState(free), 'open')
  const withdrawn = await s.t.admin
    .selectFrom('runs')
    .select(['failure_class', 'withdrawn_at', 'failure_summary'])
    .where('id', 'in', [free, pinned])
    .execute()
  for (const row of withdrawn) {
    assert.equal(row.failure_class, 'infra')
    assert.ok(row.withdrawn_at, 'listed in the next HelloAck')
    assert.match(row.failure_summary ?? '', /machine build-01 was revoked/)
  }

  assert.deepEqual(
    (await s.runsOfJobOf(pinned)).map((r) => [r.attempt, r.state]),
    [[1, 'stopped']],
  )
  assert.equal(await s.jobState(pinned), 'failed')
  assert.equal(await s.jobState(runOf(pinnedView, 'after-p')), 'skipped')
})

test('revoke ends a pinned queued run once and fails its job, with no retry rows', async () => {
  const s = await setup({ max_attempts: 3, backoff_s: 0, on: ['infra'] })
  const queued = (await enqueueRun(s.ctx, PINNED)).id
  const running = (await enqueueRun(s.ctx, PINNED)).id
  await s.offer(running)
  await s.start(running)
  await revokeMachine(s.ctx, 'build-01')

  const [only] = await s.runsOfJobOf(queued)
  assert.equal((await s.runsOfJobOf(queued)).length, 1)
  assert.deepEqual([only.attempt, only.state], [1, 'stopped'])
  assert.match(only.failure_summary ?? '', /machine build-01 was revoked; the job is pinned to it/)
  assert.equal(await s.jobState(queued), 'failed')
  // A run that ran fails, class infra, and its retry would be pinned to the revoked machine: the job fails instead.
  assert.deepEqual(
    (await s.runsOfJobOf(running)).map((r) => [r.attempt, r.state]),
    [[1, 'failed']],
  )
  assert.equal(await s.jobState(running), 'failed')
})

// A retry keeps the job's pin; on a revoked machine no claim would ever take it, so it would wait queued for good.
test('a retry of a job pinned to a revoked machine answers DR201', async () => {
  const s = await setup()
  const run = (await enqueueRun(s.ctx, PINNED)).id
  assert.equal(await s.claim(), run)
  await s.end(run, { exit: 1 })
  await revokeMachine(s.ctx, 'build-01')

  await assert.rejects(
    retryRun(s.ctx, run),
    (err: Error & { code?: string; data?: unknown }) =>
      err.code === 'DR201' && JSON.stringify(err.data) === JSON.stringify({ kind: 'machine', key: 'build-01' }),
  )
  assert.equal((await s.runsOfJobOf(run)).length, 1)
  assert.equal(await s.jobState(run), 'failed')
})

test('a retry of a red dependency reopens its skipped dependents, which wait for it', async () => {
  const s = await setup()
  const view = await s.batch([{ ref: 'a' }, { ref: 'b', depends_on: ['a'] }, { ref: 'c', depends_on: ['b'] }])
  assert.equal(await s.claim(), runOf(view, 'a'))
  await s.end(runOf(view, 'a'), { exit: 1 })
  assert.equal(await s.jobState(runOf(view, 'c')), 'skipped')

  const retry = await retryRun(s.ctx, runOf(view, 'a'))
  for (const ref of ['b', 'c']) {
    assert.equal(await s.jobState(runOf(view, ref)), 'open', ref)
    // Never ran, so the new run is a requeue: it does not count toward max_attempts.
    assert.deepEqual(
      (await s.runsOfJobOf(runOf(view, ref))).map((r) => [r.attempt, r.cause, r.state]),
      [
        [1, 'first', 'skipped'],
        [2, 'requeue', 'queued'],
      ],
      ref,
    )
  }
  assert.equal(await s.claim(), retry.id)
  assert.equal(await s.claim(), null)
  await s.end(retry.id)
  const [, b] = await s.runsOfJobOf(runOf(view, 'b'))
  assert.equal(await s.claim(), b.id)
})

// An executor event holding run R of a pinned job when the revoke starts: the revoke waits on R, the event commits R
// ended with a retry R2 still pinned to the machine, and the revoke must still end R2 (a later snapshot sees it).
test('revoke ends a pinned retry committed by a transaction it waited on', async () => {
  const s = await setup({ max_attempts: 3, backoff_s: 0, on: ['infra'] })
  const r = (await enqueueRun(s.ctx, PINNED)).id
  assert.equal(await s.claim(), r)
  await s.start(r)

  let release: () => void = () => {}
  const released = new Promise<void>((resolve) => (release = resolve))
  let locked: () => void = () => {}
  const isLocked = new Promise<void>((resolve) => (locked = resolve))
  // Transaction A: what applyRunEvent → settleJob does for a retryable failure, held open until the revoke waits.
  const holder = withTenant(s.t.db, s.ctx.tenantId, async (trx) => {
    await trx.selectFrom('runs').select('id').where('id', '=', r).forNoKeyUpdate().execute()
    locked()
    await released
    await trx
      .updateTable('runs')
      .set({ state: 'failed', finished_at: sql<Date>`now()`, failure_class: 'infra' })
      .where('id', '=', r)
      .execute()
    const job = await trx.selectFrom('runs').select('job_id').where('id', '=', r).executeTakeFirstOrThrow()
    await queueRetry(trx, s.ctx.tenantId, job.job_id)
  })
  await isLocked
  const revoking = revokeMachine(s.ctx, 'build-01')
  // The revoke is waiting on R's row lock.
  for (let i = 0; ; i++) {
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from pg_stat_activity
      where wait_event_type = 'Lock' and query like '%for no key update of r%'`.execute(s.t.admin)
    if (rows[0].n > 0) break
    assert.ok(i < 200, 'the revoke never waited on the run')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  release()
  await holder
  await revoking

  assert.deepEqual(
    (await s.runsOfJobOf(r)).map((run) => [run.attempt, run.cause, run.state]),
    [
      [1, 'first', 'failed'],
      [2, 'retry', 'stopped'],
    ],
  )
  assert.equal(await s.jobState(r), 'failed')
})

// claim_run never takes a job behind a red dependency, so such a retry would wait queued for good.
test('a retry of a skipped job behind a red dependency is skipped at once, naming the failed dependency', async () => {
  const s = await setup()
  const view = await s.batch([{ ref: 'a' }, { ref: 'b', depends_on: ['a'] }, { ref: 'c', depends_on: ['b'] }])
  assert.equal(await s.claim(), runOf(view, 'a'))
  await s.end(runOf(view, 'a'), { exit: 1 })

  for (const ref of ['b', 'c']) {
    const retried = await retryRun(s.ctx, runOf(view, ref))
    assert.deepEqual(
      [retried.attempt, retried.cause, retried.state, retried.outcome.failureSummary],
      [2, 'retry', 'skipped', 'skipped: dependency a failed'],
      ref,
    )
    assert.equal(await s.jobState(runOf(view, ref)), 'skipped', ref)
  }
  // b's retry reopened nothing: c has its first run and the retry above, both skipped.
  assert.deepEqual(
    (await s.runsOfJobOf(runOf(view, 'c'))).map((run) => [run.attempt, run.state]),
    [
      [1, 'skipped'],
      [2, 'skipped'],
    ],
  )
  assert.equal(await s.claim(), null)
})
