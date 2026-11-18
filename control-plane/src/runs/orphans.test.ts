import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import type { RunEvent } from '../executor/protocol.ts'
import { putJobType } from '../job-types/service.ts'
import type { Ctx } from '../planning/resolve.ts'
import { createProject } from '../planning/service.ts'
import { withTenant } from '../tenancy/scope.ts'
import { testDb } from '../test-support/db.ts'
import { applyOrphans, applyRunEvent, createRun, markOffered } from './record.ts'

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
  const runOf = async (jobTypeKey: string, until: 'offered' | 'running') => {
    const created = await createRun(ctx, { projectKey, jobTypeKey, machineName: 'build-01', cwd: 'C:\\work' })
    await markOffered(ctx, created.id)
    if (until === 'running') {
      await applyRunEvent(ctx, machineId, { kind: 'Admitted', run: created.id }, AT)
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
  return { ctx, machineId, runOf, row }
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
  const alreadyOrphaned = await runOf('check', 'running')
  await applyOrphans(ctx, machineId, orphans([alreadyOrphaned, true]), AT)

  const warned: unknown[] = []
  const replies = await applyOrphans(
    ctx,
    machineId,
    orphans([alreadyOrphaned, true], [dead, false], [neverStarted, false]),
    AT,
    { warn: (data) => warned.push(data) },
  )

  // The repeat of an orphan already handled is logged and skipped: no second Stop.
  assert.deepEqual(replies, [])
  assert.deepEqual(warned, [{ code: 'DR351', machineId, run: alreadyOrphaned }])
  for (const runId of [dead, neverStarted]) {
    const after = await row(runId)
    assert.equal(after.state, 'failed')
    assert.equal(after.failure_class, 'infra')
    assert.equal(after.failure_summary, 'executor restarted; the run ended while unsupervised')
    assert.equal(after.orphan_action, null)
    assert.ok(after.finished_at)
  }
})
