import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { putJobType } from '../job-types/service.ts'
import { enqueueRun } from '../jobs/enqueue.ts'
import type { Ctx } from '../planning/resolve.ts'
import { createProject } from '../planning/service.ts'
import { withTenant } from '../tenancy/scope.ts'
import { testDb } from '../test-support/db.ts'
import { listQueues, putQueue } from './service.ts'

const projectKey = 'devrounds'

async function setup() {
  const t = await testDb()
  const tenant = await t.newTenant()
  const ctx: Ctx = { db: t.db, tenantId: tenant.tenantId, actor: { id: tenant.human.id, kind: 'human' } }
  await createProject(ctx, { key: projectKey, name: 'DevRounds' })
  await putJobType(ctx, projectKey, { key: 'check', command: { program: 'pnpm', args: ['check'] } })
  return { t, ctx }
}

test('queue list reports depth, in flight and the oldest queued time', async () => {
  const { t, ctx } = await setup()
  await putQueue(ctx, projectKey, { key: 'fast', priority: 5, jobTypes: ['check'] })
  const enqueue = () => enqueueRun(ctx, { projectKey, jobTypeKey: 'check', cwd: 'C:\\work' })
  const first = await enqueue()
  const second = await enqueue()
  await enqueue()
  // Offered and running count in flight, not in the depth; the oldest queued run is then the second one.
  // An offered run sits on a machine (runs_placed_machine_check).
  const machine = await withTenant(t.db, ctx.tenantId, (trx) =>
    trx
      .insertInto('machines')
      .values({
        tenant_id: ctx.tenantId,
        name: 'build-01',
        token_hash: randomBytes(32),
        os: 'windows',
        executor_version: '0.1.0',
      })
      .returning('id')
      .executeTakeFirstOrThrow(),
  )
  await t.admin
    .updateTable('runs')
    .set({ state: 'offered', machine_id: machine.id })
    .where('id', '=', first.id)
    .execute()
  const older = new Date('2026-01-01T00:00:00Z')
  await t.admin.updateTable('runs').set({ queued_at: older, not_before: older }).where('id', '=', second.id).execute()

  assert.deepEqual(await listQueues(ctx, projectKey), [
    {
      key: 'fast',
      priority: 5,
      concurrency: null,
      machineConcurrency: null,
      jobTypes: ['check'],
      depth: 0,
      inFlight: 0,
      oldestQueuedAt: null,
    },
    {
      key: 'default',
      priority: 0,
      concurrency: null,
      machineConcurrency: null,
      jobTypes: [],
      depth: 2,
      inFlight: 1,
      oldestQueuedAt: older,
    },
  ])
})

test('machine concurrency none clears the cap', async () => {
  const { ctx } = await setup()
  const capped = await putQueue(ctx, projectKey, { key: 'default', machineConcurrency: 1, concurrency: 3 })
  assert.deepEqual([capped.machineConcurrency, capped.concurrency], [1, 3])
  // An omitted field keeps its value.
  const kept = await putQueue(ctx, projectKey, { key: 'default', priority: 2 })
  assert.equal(kept.machineConcurrency, 1)
  const cleared = await putQueue(ctx, projectKey, { key: 'default', machineConcurrency: null })
  assert.deepEqual([cleared.machineConcurrency, cleared.concurrency], [null, 3])
})

test('concurrency none clears the cap', async () => {
  const { ctx } = await setup()
  const capped = await putQueue(ctx, projectKey, { key: 'default', concurrency: 2, jobTypes: ['check'] })
  assert.equal(capped.concurrency, 2)
  // Omitted fields keep their value; null clears the cap and [] lets every job type in.
  const cleared = await putQueue(ctx, projectKey, { key: 'default', concurrency: null })
  assert.deepEqual([cleared.concurrency, cleared.jobTypes], [null, ['check']])
  const open = await putQueue(ctx, projectKey, { key: 'default', jobTypes: [] })
  assert.deepEqual([open.concurrency, open.jobTypes], [null, []])
})
