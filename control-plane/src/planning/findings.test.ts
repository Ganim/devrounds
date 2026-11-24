import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sql } from 'kysely'
import { DevRoundsError } from '../errors/error.ts'
import { withTenant } from '../tenancy/scope.ts'
import { testDb } from '../test-support/db.ts'
import { openFinding } from './findings.ts'
import { addTask, type Ctx, checkCriterion, createProject, transition } from './service.ts'
import { getPlan, listEvents } from './view.ts'

const projectKey = 'devrounds'

async function setup() {
  const { db, newTenant } = await testDb()
  const tenant = await newTenant()
  const ctx: Ctx = { db, tenantId: tenant.tenantId, actor: { id: tenant.agent.id, kind: 'agent' } }
  await createProject(ctx, { key: projectKey, name: 'DevRounds' })
  return { ctx, newTenant }
}

async function unphased(ctx: Ctx) {
  return (await getPlan(ctx, projectKey)).unphased
}

async function finish(ctx: Ctx, key: string) {
  await transition(ctx, { projectKey, taskKey: key, to: 'in_progress' })
  await transition(ctx, { projectKey, taskKey: key, to: 'done' })
}

test('a second open with the same source key returns the open task, created false, no event', async () => {
  const { ctx } = await setup()
  const first = await openFinding(ctx, projectKey, {
    sourceKey: 'lint:no-sync',
    title: 'Sync fs call',
    criteria: ['fixed'],
  })
  const before = (await listEvents(ctx, projectKey, { limit: 1000 })).length

  const second = await openFinding(ctx, projectKey, { sourceKey: 'lint:no-sync', title: 'Sync fs call again' })

  assert.equal(first.created, true)
  assert.equal(first.key, 'F-0001')
  assert.ok(first.eventId)
  assert.deepEqual(second, { key: 'F-0001', created: false, eventId: null })
  assert.equal((await listEvents(ctx, projectKey, { limit: 1000 })).length, before)
  const [task] = await unphased(ctx)
  assert.deepEqual(
    [task.key, task.title, task.sourceKey, task.criteria.map((c) => c.text)],
    ['F-0001', 'Sync fs call', 'lint:no-sync', ['fixed']],
  )
})

test('after that task is done the key opens F-0002', async () => {
  const { ctx } = await setup()
  await openFinding(ctx, projectKey, { sourceKey: 'flaky:api', title: 'Flaky api test' })
  await finish(ctx, 'F-0001')

  const next = await openFinding(ctx, projectKey, { sourceKey: 'flaky:api', title: 'Flaky api test' })

  assert.deepEqual([next.key, next.created], ['F-0002', true])
  assert.deepEqual(
    (await unphased(ctx)).map((t) => [t.key, t.state, t.sourceKey]),
    [
      ['F-0001', 'done', 'flaky:api'],
      ['F-0002', 'todo', 'flaky:api'],
    ],
  )
})

test('reopening the done one while F-0002 is open answers DR309', async () => {
  const { ctx } = await setup()
  await openFinding(ctx, projectKey, { sourceKey: 'flaky:api', title: 'Flaky api test', criteria: ['fixed'] })
  await transition(ctx, { projectKey, taskKey: 'F-0001', to: 'in_progress' })
  await checkCriterion(ctx, { projectKey, taskKey: 'F-0001', position: 1, evidence: 'commit:abcdef1' })
  await transition(ctx, { projectKey, taskKey: 'F-0001', to: 'done' })
  await openFinding(ctx, projectKey, { sourceKey: 'flaky:api', title: 'Flaky api test' })

  await assert.rejects(
    transition(ctx, { projectKey, taskKey: 'F-0001', to: 'in_progress', reason: 'came back' }),
    (err) => {
      assert.ok(err instanceof DevRoundsError, String(err))
      assert.deepEqual([err.code, err.data], ['DR309', { task: 'F-0002', sourceKey: 'flaky:api' }])
      return true
    },
  )
  assert.equal((await unphased(ctx)).find((t) => t.key === 'F-0001')?.state, 'done')
})

test('concurrent opens of one key make one task', async () => {
  const { ctx } = await setup()
  const { admin } = await testDb()
  const input = { sourceKey: 'gate:types', title: 'Typecheck fails' }
  let firstDone!: () => void
  let commit!: () => void
  const opened = new Promise<void>((resolve) => {
    firstDone = resolve
  })
  const held = new Promise<void>((resolve) => {
    commit = resolve
  })

  const a = withTenant(ctx.db, ctx.tenantId, async (trx) => {
    try {
      return await openFinding({ ...ctx, trx }, projectKey, input)
    } finally {
      firstDone()
      await held
    }
  })
  await opened
  const b = openFinding(ctx, projectKey, input)
  // The second waits on the first's project lock; commit only once it is waiting.
  for (let waited = 0; waited < 5000; waited += 20) {
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from pg_stat_activity
      where wait_event_type = 'Lock' and query like '%"projects"%'`.execute(admin)
    if (rows[0].n > 0) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  commit()

  const results = await Promise.all([a, b])
  assert.deepEqual(
    results.map((r) => [r.key, r.created]),
    [
      ['F-0001', true],
      ['F-0001', false],
    ],
  )
  assert.deepEqual(
    (await unphased(ctx)).map((t) => t.key),
    ['F-0001'],
  )
})

test('keys follow the highest F- key, not the count', async () => {
  const { ctx } = await setup()
  await addTask(ctx, { projectKey, key: 'F-0007', title: 'Imported finding' })
  await addTask(ctx, { projectKey, key: 'F-12', title: 'Not a finding key' })

  const opened = await openFinding(ctx, projectKey, { sourceKey: 'lint:x', title: 'Lint' })

  assert.equal(opened.key, 'F-0008')
})

test('a finding of another tenant is not seen', async () => {
  const { ctx, newTenant } = await setup()
  await openFinding(ctx, projectKey, { sourceKey: 'lint:x', title: 'Lint' })
  const other = await newTenant()
  const otherCtx: Ctx = { db: ctx.db, tenantId: other.tenantId, actor: { id: other.agent.id, kind: 'agent' } }
  await createProject(otherCtx, { key: projectKey, name: 'Other' })

  const opened = await openFinding(otherCtx, projectKey, { sourceKey: 'lint:x', title: 'Lint' })

  assert.deepEqual([opened.key, opened.created], ['F-0001', true])
  assert.equal((await unphased(otherCtx)).length, 1)
})
