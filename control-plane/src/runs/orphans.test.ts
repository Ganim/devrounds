import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import type { RunEvent } from '../executor/protocol.ts'
import { putJobType } from '../job-types/service.ts'
import type { Ctx } from '../planning/resolve.ts'
import { createProject } from '../planning/service.ts'
import { withTenant } from '../tenancy/scope.ts'
import { testDb } from '../test-support/db.ts'
import { applyOrphans, applyRunEvent, createRun, markOffered, pendingOrphanStops } from './record.ts'

const projectKey = 'devrounds'
const AT = new Date('2026-11-18T12:00:00Z')

type OrphansEvent = Extract<RunEvent, { kind: 'Orphans' }>

async function setup() {
  const t = await testDb()
  const tenant = await t.newTenant()
  const ctx: Ctx = { db: t.db, tenantId: tenant.tenantId, actor: { id: tenant.human.id, kind: 'human' } }
  await createProject(ctx, { key: projectKey, name: 'DevRounds' })
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
  for (const [key, orphan_policy] of [
    ['check', 'kill'],
    ['serve', 'let_finish'],
  ] as const) {
    await putJobType(ctx, projectKey, {
      key,
      command: { program: 'pnpm', args: [key] },
      env: ['PATH'],
      timeout_s: 600,
      orphan_policy,
      classify: [],
    })
  }
  // A run of `jobTypeKey` as far as `until`, as its executor reported it before the restart.
  const runOf = async (jobTypeKey: string, until: 'offered' | 'admitted' | 'running') => {
    const created = await createRun(ctx, { projectKey, jobTypeKey, machineName: 'build-01', cwd: 'C:\\work' })
    await markOffered(ctx, created.id)
    if (until !== 'offered') await applyRunEvent(ctx, machineId, { kind: 'Admitted', run: created.id }, AT)
    if (until === 'running') {
      const started = { kind: 'RunStarted', run: created.id, pid: 42, start_time: '1', boot_id: 'boot-1' } as const
      await applyRunEvent(ctx, machineId, started, AT)
    }
    return created.id
  }
  const row = (runId: string) =>
    t.admin
      .selectFrom('runs')
      .select(['state', 'failure_class', 'failure_summary', 'orphan_action', 'finished_at'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow()
  // Moves when `runId` became orphaned back by `days`.
  const orphanedDaysAgo = (runId: string, days: number) =>
    t.admin
      .updateTable('runs')
      .set({ orphaned_at: new Date(Date.now() - days * 24 * 60 * 60 * 1000) })
      .where('id', '=', runId)
      .execute()
  return { ctx, machineId, runOf, row, orphanedDaysAgo }
}

const orphans = (...runs: [string, boolean][]): OrphansEvent => ({
  kind: 'Orphans',
  runs: runs.map(([run, alive]) => ({ run, alive })),
})

test('orphans with the kill policy get a Stop and stay orphaned with class infra', async () => {
  const { ctx, machineId, runOf, row } = await setup()
  const runId = await runOf('check', 'running')

  const replies = await applyOrphans(ctx, machineId, orphans([runId, true]), AT)

  assert.deepEqual(replies, [{ type: 'Stop', run: runId, reason: 'orphan_policy' }])
  assert.deepEqual(await row(runId), {
    state: 'orphaned',
    failure_class: 'infra',
    failure_summary: null,
    orphan_action: 'killed',
    finished_at: null,
  })
})

// The executor restarted again before it acted on the Stop: it reports the run alive once more.
test('an alive repeat of an orphan already killed answers its Stop again', async () => {
  const { ctx, machineId, runOf, row } = await setup()
  const runId = await runOf('check', 'running')
  await applyOrphans(ctx, machineId, orphans([runId, true]), AT)
  const warned: unknown[] = []

  const replies = await applyOrphans(ctx, machineId, orphans([runId, true]), AT, { warn: (d) => warned.push(d) })

  assert.deepEqual(replies, [{ type: 'Stop', run: runId, reason: 'orphan_policy' }])
  assert.deepEqual(warned, [])
  assert.equal((await row(runId)).state, 'orphaned')
})

// Orphaned is terminal: without a window, every HelloAck would stop every run the machine ever had killed.
test('after HelloAck, only runs orphaned to be killed within the window get their Stop again', async () => {
  const { ctx, machineId, runOf, orphanedDaysAgo } = await setup()
  const old = await runOf('check', 'running')
  const recent = await runOf('check', 'running')
  const now = await runOf('check', 'running')
  await applyOrphans(ctx, machineId, orphans([old, true], [recent, true], [now, true]), new Date())
  await orphanedDaysAgo(old, 8)
  await orphanedDaysAgo(recent, 6)

  const stopped = (await pendingOrphanStops(ctx, machineId)).map((stop) => stop.run)
  assert.deepEqual(stopped.sort(), [recent, now].sort())
})

// A crash between storing the leader and appending RunStarted: the control plane last saw the run admitted.
test('an orphan the control plane still has admitted is orphaned or failed all the same', async () => {
  const { ctx, machineId, runOf, row } = await setup()
  const alive = await runOf('check', 'admitted')
  const dead = await runOf('check', 'admitted')

  const replies = await applyOrphans(ctx, machineId, orphans([alive, true], [dead, false]), AT)

  assert.deepEqual(replies, [{ type: 'Stop', run: alive, reason: 'orphan_policy' }])
  assert.equal((await row(alive)).state, 'orphaned')
  assert.equal((await row(dead)).state, 'failed')
})

test('let_finish sends nothing', async () => {
  const { ctx, machineId, runOf, row } = await setup()
  const runId = await runOf('serve', 'running')

  assert.deepEqual(await applyOrphans(ctx, machineId, orphans([runId, true]), AT), [])
  const after = await row(runId)
  assert.equal(after.state, 'orphaned')
  assert.equal(after.failure_class, 'infra')
  assert.equal(after.orphan_action, 'let_finish')
})

test('a dead orphan fails with class infra, and one the record cannot take does not stop the others', async () => {
  const { ctx, machineId, runOf, row } = await setup()
  const dead = await runOf('check', 'running')
  const neverStarted = await runOf('serve', 'offered')
  const letFinish = await runOf('serve', 'running')
  await applyOrphans(ctx, machineId, orphans([letFinish, true]), AT)

  const warned: unknown[] = []
  const replies = await applyOrphans(
    ctx,
    machineId,
    orphans([letFinish, true], [dead, false], [neverStarted, false]),
    AT,
    { warn: (data) => warned.push(data) },
  )

  // The repeat of a let_finish orphan already handled is logged and skipped.
  assert.deepEqual(replies, [])
  assert.deepEqual(warned, [{ code: 'DR351', machineId, run: letFinish }])
  for (const runId of [dead, neverStarted]) {
    const after = await row(runId)
    assert.equal(after.state, 'failed')
    assert.equal(after.failure_class, 'infra')
    assert.equal(after.failure_summary, 'executor restarted; the run ended while unsupervised')
    assert.equal(after.orphan_action, null)
    assert.ok(after.finished_at)
  }
})
