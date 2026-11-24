import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { sql } from 'kysely'
import { DevRoundsError } from '../errors/error.ts'
import { Sessions } from '../executor/gateway.ts'
import type { RunEvent } from '../executor/protocol.ts'
import type { JobTypeFile } from '../job-types/file.ts'
import { putJobType } from '../job-types/service.ts'
import type { Ctx } from '../planning/resolve.ts'
import { createProject } from '../planning/service.ts'
import { runEvents, stopRun } from '../runs/dispatch.ts'
import { applyRunEvent, retryRun } from '../runs/record.ts'
import { withTenant } from '../tenancy/scope.ts'
import { testDb } from '../test-support/db.ts'
import type { GateFile, GateInput } from './file.ts'
import { type GateView, gateView, submitGate, waitForGate } from './service.ts'

const projectKey = 'devrounds'

const failsWith =
  (code: string, data: Record<string, unknown> = {}) =>
  (err: unknown) =>
    err instanceof DevRoundsError &&
    err.code === code &&
    Object.entries(data).every(([key, value]) => err.data[key] === value)

// A tenant with project `devrounds`, job types `check` (exit 1 is check_red, retry policy `retry`) and `lint`, and
// machine `build-01`.
async function setup(retry?: JobTypeFile['retry']) {
  const t = await testDb()
  const tenant = await t.newTenant()
  const ctx: Ctx = { db: t.db, tenantId: tenant.tenantId, actor: { id: tenant.human.id, kind: 'human' } }
  await createProject(ctx, { key: projectKey, name: 'DevRounds' })
  for (const key of ['check', 'lint']) {
    await putJobType(ctx, projectKey, {
      key,
      command: { program: 'node', args: [key] },
      classify: [{ class: 'check_red', exit_codes: [1] }],
      ...(retry === undefined ? {} : { retry }),
    })
  }
  const addMachine = (name: string) =>
    withTenant(t.db, tenant.tenantId, async (trx) => {
      const row = await trx
        .insertInto('machines')
        .values({
          tenant_id: tenant.tenantId,
          name,
          token_hash: randomBytes(32),
          os: 'windows',
          executor_version: '0.1.0',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      return row.id
    })
  const machineId = await addMachine('build-01')
  const event = (e: RunEvent) => applyRunEvent(ctx, machineId, e, new Date())
  // Offers `runId` on build-01 whatever its not_before, and ends it: exit 0 finishes it, exit 1 is check_red.
  const end = async (runId: string, exit = 0) => {
    await t.admin
      .updateTable('runs')
      .set({ state: 'offered', machine_id: machineId, offered_at: sql<Date>`now()` })
      .where('id', '=', runId)
      .where('state', '=', 'queued')
      .execute()
    await event({ kind: 'Admitted', run: runId })
    await event({ kind: 'RunStarted', run: runId, pid: 42, start_time: '1', boot_id: 'boot-1' })
    await event({
      kind: 'RunFinished',
      run: runId,
      reason: 'exited',
      exit_code: exit,
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
  const submit = (file: GateFile, o: Partial<Omit<GateInput, 'file'>> = {}) =>
    submitGate(ctx, projectKey, { file, cwd: 'C:\\src\\app', machine: 'build-01', ...o })
  const show = (id: string) => gateView(ctx, projectKey, id)
  return { t, tenant, ctx, machineId, addMachine, end, submit, show }
}

// prepare first, every other check after it (design call 9).
const PRE_PR: GateFile = {
  key: 'pre-pr',
  checks: [
    { ref: 'prepare', job_type: 'check' },
    { ref: 'lint', job_type: 'lint', depends_on: ['prepare'] },
    { ref: 'test', job_type: 'check', depends_on: ['prepare'], args: [] },
  ],
}

const ONE: GateFile = { key: 'one', checks: [{ ref: 'only', job_type: 'check' }] }

const runOf = (view: GateView, ref: string) => view.checks.find((check) => check.ref === ref)?.runId as string

test('a gate pins every check to its machine in queue gates with the depends_on edges and is running', async () => {
  const s = await setup()
  const gate = await s.submit(PRE_PR, { headSha: 'abc1234', dirty: true })
  assert.deepEqual(
    [gate.key, gate.state, gate.machine, gate.cwd, gate.headSha, gate.dirty, gate.finishedAt, gate.wallMs],
    ['pre-pr', 'running', 'build-01', 'C:\\src\\app', 'abc1234', true, null, null],
  )
  assert.deepEqual(
    gate.checks.map((c) => [c.ref, c.jobType, c.state, c.runState, c.attempt, c.cachedFrom]),
    [
      ['lint', 'lint', 'open', 'queued', 1, null],
      ['prepare', 'check', 'open', 'queued', 1, null],
      ['test', 'check', 'open', 'queued', 1, null],
    ],
  )
  assert.deepEqual(await s.show(gate.id), gate)

  const jobs = await s.t.admin
    .selectFrom('jobs as j')
    .innerJoin('queues as q', 'q.id', 'j.queue_id')
    .select(['j.ref', 'j.machine_id', 'j.cwd', 'q.key as queue'])
    .where('j.batch_id', '=', gate.batch)
    .orderBy('j.ref')
    .execute()
  assert.deepEqual(
    jobs.map((j) => [j.ref, j.machine_id, j.cwd, j.queue]),
    ['lint', 'prepare', 'test'].map((ref) => [ref, s.machineId, 'C:\\src\\app', 'gates']),
  )
  const edges = await s.t.admin
    .selectFrom('job_dependencies as e')
    .innerJoin('jobs as j', 'j.id', 'e.job_id')
    .innerJoin('jobs as d', 'd.id', 'e.depends_on_job_id')
    .select(['j.ref as job', 'd.ref as dependsOn'])
    .where('j.batch_id', '=', gate.batch)
    .orderBy(['j.ref', 'd.ref'])
    .execute()
  assert.deepEqual(
    edges.map((e) => `${e.job}→${e.dependsOn}`),
    ['lint→prepare', 'test→prepare'],
  )
})

test('a second gate on the same worktree spelled differently answers DR308 naming the first', async () => {
  const s = await setup()
  const first = await s.submit(ONE, { cwd: 'C:\\src\\app\\' })
  await assert.rejects(
    s.submit(ONE, { cwd: 'c:/src/app' }),
    failsWith('DR308', { gate: first.id, machine: 'build-01', cwd: 'c:/src/app' }),
  )
  // The refused submit left nothing behind: one gate, one batch.
  const gates = await s.t.admin.selectFrom('gates').select('id').where('tenant_id', '=', s.tenant.tenantId).execute()
  assert.deepEqual(
    gates.map((g) => g.id),
    [first.id],
  )
})

test('two concurrent submits for one worktree make one gate and one DR308', async () => {
  const s = await setup()
  const [a, b] = await Promise.allSettled([
    s.submit(ONE, { cwd: 'c:\\src\\app' }),
    s.submit(ONE, { cwd: 'C:/src/app/' }),
  ])
  const made = [a, b].filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<GateView>).value)
  const refused = [a, b].filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason)
  assert.equal(made.length, 1)
  assert.equal(refused.length, 1)
  assert.ok(failsWith('DR308', { gate: made[0].id })(refused[0]), String(refused[0]))
  const running = await s.t.admin
    .selectFrom('gates')
    .select('id')
    .where('tenant_id', '=', s.tenant.tenantId)
    .where('state', '=', 'running')
    .execute()
  assert.equal(running.length, 1)
})

test('another cwd or machine runs beside it', async () => {
  const s = await setup()
  await s.addMachine('build-02')
  const first = await s.submit(ONE)
  const otherCwd = await s.submit(ONE, { cwd: 'C:\\src\\app-2' })
  const otherMachine = await s.submit(ONE, { machine: 'build-02' })
  assert.deepEqual(
    [first.state, otherCwd.state, otherMachine.state, otherMachine.machine],
    ['running', 'running', 'running', 'build-02'],
  )
})

test('the gate passes when its last check finishes, and the worktree takes a new gate', async () => {
  const s = await setup()
  const gate = await s.submit(PRE_PR)
  await s.end(runOf(gate, 'prepare'))
  await s.end(runOf(gate, 'lint'))
  assert.equal((await s.show(gate.id)).state, 'running')
  await assert.rejects(s.submit(ONE), failsWith('DR308', { gate: gate.id }))

  // A waiter wakes on the change of one of the gate's runs and returns the ended gate.
  const waiting = waitForGate(s.ctx, projectKey, gate.id, 30)
  await s.end(runOf(gate, 'test'))
  runEvents.emit('changed', runOf(gate, 'test'))
  const passed = await waiting
  assert.equal(passed.state, 'passed')
  assert.ok(passed.finishedAt instanceof Date)
  assert.equal(passed.wallMs, passed.finishedAt.getTime() - passed.createdAt.getTime())
  assert.deepEqual(
    passed.checks.map((c) => [c.ref, c.state, c.runState]),
    [
      ['lint', 'finished', 'finished'],
      ['prepare', 'finished', 'finished'],
      ['test', 'finished', 'finished'],
    ],
  )
  assert.ok(passed.checks.every((c) => c.durationMs !== null && c.durationMs >= 0))
  assert.deepEqual(await s.show(gate.id), passed)
  assert.equal((await s.submit(ONE)).state, 'running')
})

test("gate view carries each check's exit code, null for skipped and queued", async () => {
  const s = await setup()
  const gate = await s.submit({
    key: 'codes',
    checks: [
      { ref: 'a', job_type: 'check' },
      { ref: 'b', job_type: 'check', depends_on: ['a'] },
      { ref: 'c', job_type: 'lint' },
      { ref: 'd', job_type: 'lint', depends_on: ['c'] },
    ],
  })
  await s.end(runOf(gate, 'a'), 1)
  await s.end(runOf(gate, 'c'), 0)
  assert.deepEqual(
    (await s.show(gate.id)).checks.map((c) => [c.ref, c.runState, c.exitCode]),
    [
      ['a', 'failed', 1],
      ['b', 'skipped', null],
      ['c', 'finished', 0],
      ['d', 'queued', null],
    ],
  )
})

test("a cached check shows its source run's exit code", async () => {
  const s = await setup()
  const file: GateFile = { key: 'cached-code', checks: [{ ref: 'only', job_type: 'check', cache_key: 'tree-1' }] }
  const first = await s.submit(file)
  await s.end(runOf(first, 'only'))
  const second = await s.submit(file)
  assert.equal(second.checks[0].cachedFrom, runOf(first, 'only'))
  assert.equal(second.checks[0].exitCode, 0)
})

test('a red check fails the gate once its dependents are skipped', async () => {
  const s = await setup()
  const gate = await s.submit({
    key: 'red',
    checks: [
      { ref: 'a', job_type: 'check' },
      { ref: 'b', job_type: 'check', depends_on: ['a'] },
      { ref: 'c', job_type: 'lint' },
    ],
  })
  await s.end(runOf(gate, 'c'))
  assert.equal((await s.show(gate.id)).state, 'running')
  // a's end skips b, the last open check, in the same transaction: nothing is left open.
  await s.end(runOf(gate, 'a'), 1)
  const failed = await s.show(gate.id)
  assert.equal(failed.state, 'failed')
  assert.deepEqual(
    failed.checks.map((c) => [c.ref, c.state, c.runState, c.failureClass, c.failureSummary]),
    [
      ['a', 'failed', 'failed', 'check_red', null],
      ['b', 'skipped', 'skipped', null, 'skipped: dependency a failed'],
      ['c', 'finished', 'finished', null, null],
    ],
  )
  assert.equal((await s.submit(ONE)).state, 'running')
})

test('a check stopped with nothing red ends it cancelled', async () => {
  const s = await setup()
  const gate = await s.submit({
    key: 'stop',
    checks: [
      { ref: 'a', job_type: 'check' },
      { ref: 'b', job_type: 'lint' },
    ],
  })
  await stopRun(s.ctx, new Sessions(), runOf(gate, 'a'), projectKey)
  assert.equal((await s.show(gate.id)).state, 'running')
  await s.end(runOf(gate, 'b'))
  const cancelled = await s.show(gate.id)
  assert.equal(cancelled.state, 'cancelled')
  assert.deepEqual(
    cancelled.checks.map((c) => [c.ref, c.runState, c.failureClass]),
    [
      ['a', 'stopped', 'cancelled'],
      ['b', 'finished', null],
    ],
  )
})

test('a check retried by its policy keeps the gate running until the retry ends', async () => {
  const s = await setup({ max_attempts: 2, on: ['check_red'] })
  const gate = await s.submit(ONE)
  await s.end(runOf(gate, 'only'), 1)
  const retrying = await s.show(gate.id)
  assert.deepEqual(
    [retrying.state, retrying.finishedAt, retrying.checks[0].state, retrying.checks[0].attempt],
    ['running', null, 'open', 2],
  )
  await assert.rejects(s.submit(ONE), failsWith('DR308', { gate: gate.id }))
  await s.end(retrying.checks[0].runId)
  const passed = await s.show(gate.id)
  assert.deepEqual([passed.state, passed.checks[0].attempt], ['passed', 2])
})

test("a person's retry after the gate ended leaves it ended", async () => {
  const s = await setup()
  const gate = await s.submit(ONE)
  await s.end(runOf(gate, 'only'), 1)
  const failed = await s.show(gate.id)
  assert.equal(failed.state, 'failed')

  const retry = await retryRun(s.ctx, runOf(gate, 'only'))
  // The worktree is free while the retried check is open.
  assert.equal((await s.submit(ONE)).state, 'running')
  await s.end(retry.id)
  const after = await s.show(gate.id)
  assert.deepEqual([after.state, after.finishedAt], ['failed', failed.finishedAt])
  assert.deepEqual([after.checks[0].state, after.checks[0].attempt], ['finished', 2])
})

test('every check cached passes the gate at submit', async () => {
  const s = await setup()
  const cachedFile: GateFile = {
    key: 'cached',
    checks: [
      { ref: 'prepare', job_type: 'check', cache_key: 'tree-1' },
      { ref: 'lint', job_type: 'lint', depends_on: ['prepare'], cache_key: 'tree-1' },
    ],
  }
  const first = await s.submit(cachedFile)
  await s.end(runOf(first, 'prepare'))
  await s.end(runOf(first, 'lint'))
  assert.equal((await s.show(first.id)).state, 'passed')

  const second = await s.submit(cachedFile)
  assert.equal(second.state, 'passed')
  assert.ok(second.finishedAt instanceof Date)
  assert.deepEqual(
    second.checks.map((c) => [c.ref, c.state, c.cachedFrom, c.durationMs]),
    [
      ['lint', 'finished', runOf(first, 'lint'), null],
      ['prepare', 'finished', runOf(first, 'prepare'), null],
    ],
  )
  // It released the worktree in the same transaction.
  assert.equal((await s.submit(ONE)).state, 'running')
})

test('with two live machines and no --machine DR101 at /machine', async () => {
  const s = await setup()
  // One live machine is the gate's machine.
  const only = await submitGate(s.ctx, projectKey, { file: ONE, cwd: 'C:\\src\\one' })
  assert.equal(only.machine, 'build-01')
  await s.addMachine('build-02')
  await assert.rejects(
    submitGate(s.ctx, projectKey, { file: ONE, cwd: 'C:\\src\\two' }),
    failsWith('DR101', { path: '/machine' }),
  )
})

test('a gate of another tenant answers DR201 kind gate', async () => {
  const s = await setup()
  const gate = await s.submit(ONE)
  const other = await s.t.newTenant()
  const otherCtx: Ctx = { db: s.t.db, tenantId: other.tenantId, actor: { id: other.human.id, kind: 'human' } }
  await createProject(otherCtx, { key: projectKey, name: 'DevRounds' })
  await assert.rejects(gateView(otherCtx, projectKey, gate.id), failsWith('DR201', { kind: 'gate', key: gate.id }))
  await assert.rejects(gateView(s.ctx, projectKey, 'not-a-uuid'), failsWith('DR201', { kind: 'gate' }))
})

test('a change announced while the first read is in flight is not missed', async () => {
  const s = await setup()
  const gate = await s.submit(ONE)
  const runId = runOf(gate, 'only')
  // Holds the runs table, so the read has the gate (running) and then waits on its checks. The gate ends meanwhile and
  // its run is announced: the read comes back stale, listing no run yet.
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let locked!: () => void
  const lockTaken = new Promise<void>((resolve) => {
    locked = resolve
  })
  const holding = s.t.admin.transaction().execute(async (trx) => {
    await sql`lock table runs in access exclusive mode`.execute(trx)
    locked()
    await held
  })
  await lockTaken
  const started = Date.now()
  const waiting = waitForGate(s.ctx, projectKey, gate.id, 20)
  for (;;) {
    const { rows } = await sql<{ n: number }>`select count(*)::int as n from pg_locks where not granted`.execute(
      s.t.admin,
    )
    if (rows[0].n > 0) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  await s.t.admin
    .updateTable('gates')
    .set({ state: 'passed', finished_at: sql<Date>`now()` })
    .where('id', '=', gate.id)
    .execute()
  runEvents.emit('changed', runId)
  release()
  await holding
  assert.equal((await waiting).state, 'passed')
  assert.ok(Date.now() - started < 10_000)
})
