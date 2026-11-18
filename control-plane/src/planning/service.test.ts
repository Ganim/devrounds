import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sql } from 'kysely'
import { DevRoundsError } from '../errors/error.ts'
import { withTenant } from '../tenancy/scope.ts'
import { testDb } from '../test-support/db.ts'
import {
  addCriterion,
  addDependency,
  addLink,
  addPhase,
  addPhaseDependency,
  addTask,
  type Ctx,
  checkCriterion,
  closePhase,
  createProject,
  editCriterion,
  editPhase,
  editTask,
  movePhase,
  removeDependency,
  removePhaseDependency,
  reopenPhase,
  transition,
} from './service.ts'
import { getPlan, listEvents } from './view.ts'

const projectKey = 'devrounds'

async function setup() {
  const { db, newTenant } = await testDb()
  const tenant = await newTenant()
  const ctx: Ctx = { db, tenantId: tenant.tenantId, actor: { id: tenant.agent.id, kind: 'agent' } }
  await createProject(ctx, { key: projectKey, name: 'DevRounds' })
  return { ctx, tenant, newTenant }
}

async function events(ctx: Ctx) {
  return listEvents(ctx, projectKey, { limit: 1000 })
}

function rejectsWith(promise: Promise<unknown>, code: string) {
  return assert.rejects(promise, (err) => {
    assert.ok(err instanceof DevRoundsError, String(err))
    assert.equal(err.code, code)
    return true
  })
}

async function taskOf(ctx: Ctx, key: string) {
  const plan = await getPlan(ctx, projectKey)
  const task = plan.phases.flatMap((phase) => phase.tasks).find((t) => t.key === key)
  assert.ok(task, `task ${key} not in plan`)
  return task
}

test('start then done with criteria checked', async () => {
  const { ctx } = await setup()
  await addPhase(ctx, { projectKey, key: 'P0', title: 'Foundation', goal: 'Plan' })
  await addTask(ctx, { projectKey, phaseKey: 'P0', key: 'P0-T01', title: 'Repo', criteria: ['tests pass'] })

  await transition(ctx, { projectKey, taskKey: 'P0-T01', to: 'in_progress' })
  await checkCriterion(ctx, { projectKey, taskKey: 'P0-T01', position: 1, evidence: 'commit:abcdef1' })
  await transition(ctx, { projectKey, taskKey: 'P0-T01', to: 'done' })

  const task = await taskOf(ctx, 'P0-T01')
  assert.equal(task.state, 'done')
  assert.equal(task.version, 2)
  assert.ok(task.startedAt)
  assert.ok(task.finishedAt)
  assert.equal(task.criteria[0].evidence, 'commit:abcdef1')
  assert.equal(task.criteria[0].checkedBy, 'agent')
  const last = (await events(ctx)).filter((e) => e.kind === 'transition').at(-1)
  assert.deepEqual(
    { taskKey: last?.taskKey, data: last?.data },
    { taskKey: 'P0-T01', data: { projectKey, taskKey: 'P0-T01', to: 'done', from: 'in_progress' } },
  )
})

test('done with open criterion → DR303, no event', async () => {
  const { ctx } = await setup()
  await addTask(ctx, { projectKey, key: 'P0-T01', title: 'Repo', criteria: ['tests pass'] })
  await transition(ctx, { projectKey, taskKey: 'P0-T01', to: 'in_progress' })
  const before = (await events(ctx)).length

  await rejectsWith(transition(ctx, { projectKey, taskKey: 'P0-T01', to: 'done' }), 'DR303')

  assert.equal((await events(ctx)).length, before)
  const plan = await getPlan(ctx, projectKey)
  assert.equal(plan.unphased[0].state, 'in_progress')
})

test('start with open blocker → DR302', async () => {
  const { ctx } = await setup()
  await addTask(ctx, { projectKey, key: 'P0-T01', title: 'First' })
  await addTask(ctx, { projectKey, key: 'P0-T02', title: 'Second', blockedBy: ['P0-T01'] })

  await rejectsWith(transition(ctx, { projectKey, taskKey: 'P0-T02', to: 'in_progress' }), 'DR302')
})

test('start in a phase blocked by an open phase → DR304', async () => {
  const { ctx } = await setup()
  await addPhase(ctx, { projectKey, key: 'P0', title: 'A', goal: '' })
  await addPhase(ctx, { projectKey, key: 'P1', title: 'B', goal: '' })
  await addPhaseDependency(ctx, { projectKey, phaseKey: 'P1', blockedByKey: 'P0' })
  await addTask(ctx, { projectKey, phaseKey: 'P1', key: 'P1-T01', title: 'Later' })

  await rejectsWith(transition(ctx, { projectKey, taskKey: 'P1-T01', to: 'in_progress' }), 'DR304')
})

test('dependency closing a cycle → DR103, nothing written', async () => {
  const { ctx } = await setup()
  await addTask(ctx, { projectKey, key: 'P0-T01', title: 'A' })
  await addTask(ctx, { projectKey, key: 'P0-T02', title: 'B', blockedBy: ['P0-T01'] })
  await addTask(ctx, { projectKey, key: 'P0-T03', title: 'C', blockedBy: ['P0-T02'] })
  await addPhase(ctx, { projectKey, key: 'P0', title: 'A', goal: '' })
  await addPhase(ctx, { projectKey, key: 'P1', title: 'B', goal: '' })
  await addPhaseDependency(ctx, { projectKey, phaseKey: 'P1', blockedByKey: 'P0' })
  const before = (await events(ctx)).length

  await rejectsWith(addDependency(ctx, { projectKey, taskKey: 'P0-T01', blockedByKey: 'P0-T03' }), 'DR103')
  await rejectsWith(addDependency(ctx, { projectKey, taskKey: 'P0-T01', blockedByKey: 'P0-T01' }), 'DR103')
  await rejectsWith(addPhaseDependency(ctx, { projectKey, phaseKey: 'P0', blockedByKey: 'P1' }), 'DR103')

  assert.equal((await events(ctx)).length, before)
  const plan = await getPlan(ctx, projectKey)
  assert.deepEqual(plan.unphased.find((t) => t.key === 'P0-T01')?.blockedBy, [])
  assert.deepEqual(plan.phases.find((p) => p.key === 'P0')?.blockedBy, [])
})

// Runs `first` in a transaction that stays open until `second` waits on a lock of the `table` rows (or 5 s pass),
// then commits it. So `second` always runs against the uncommitted first change: without the lock under test it
// would read the old state and both would succeed. Returns 'ok' or the error code of each.
async function race(
  ctx: Ctx,
  table: string,
  first: (inner: Ctx) => Promise<unknown>,
  second: () => Promise<unknown>,
): Promise<string[]> {
  const { admin } = await testDb()
  const outcome = (promise: Promise<unknown>) =>
    promise.then(
      () => 'ok',
      (err: unknown) => (err instanceof DevRoundsError ? err.code : String(err)),
    )
  let done!: () => void
  let commit!: () => void
  const firstDone = new Promise<void>((resolve) => {
    done = resolve
  })
  const held = new Promise<void>((resolve) => {
    commit = resolve
  })
  const a = outcome(
    withTenant(ctx.db, ctx.tenantId, async (trx) => {
      try {
        await first({ ...ctx, trx })
      } finally {
        done()
      }
      await held
    }),
  )
  await firstDone
  const b = outcome(second())
  for (let waited = 0; waited < 5000; waited += 20) {
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from pg_stat_activity
      where wait_event_type = 'Lock' and query like ${`%"${table}"%`}`.execute(admin)
    if (rows[0].n > 0) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  commit()
  return Promise.all([a, b])
}

test('concurrent start: one ok, one DR301', async () => {
  const { ctx } = await setup()
  await addTask(ctx, { projectKey, key: 'P0-T01', title: 'Race' })
  const start = { projectKey, taskKey: 'P0-T01', to: 'in_progress' as const }

  const results = await race(
    ctx,
    'tasks',
    (inner) => transition(inner, start),
    () => transition(ctx, start),
  )

  assert.deepEqual(results, ['ok', 'DR301'])
  const [task] = (await getPlan(ctx, projectKey)).unphased
  assert.deepEqual([task.state, task.version], ['in_progress', 1])
})

test('concurrent opposite dependencies: one ok, one DR103, no cycle stored', async () => {
  const { ctx } = await setup()
  await addTask(ctx, { projectKey, key: 'P0-T01', title: 'A' })
  await addTask(ctx, { projectKey, key: 'P0-T02', title: 'B' })
  await addPhase(ctx, { projectKey, key: 'P0', title: 'A', goal: '' })
  await addPhase(ctx, { projectKey, key: 'P1', title: 'B', goal: '' })

  const tasks = await race(
    ctx,
    'projects',
    (inner) => addDependency(inner, { projectKey, taskKey: 'P0-T01', blockedByKey: 'P0-T02' }),
    () => addDependency(ctx, { projectKey, taskKey: 'P0-T02', blockedByKey: 'P0-T01' }),
  )
  const phases = await race(
    ctx,
    'projects',
    (inner) => addPhaseDependency(inner, { projectKey, phaseKey: 'P0', blockedByKey: 'P1' }),
    () => addPhaseDependency(ctx, { projectKey, phaseKey: 'P1', blockedByKey: 'P0' }),
  )

  assert.deepEqual(
    [tasks, phases],
    [
      ['ok', 'DR103'],
      ['ok', 'DR103'],
    ],
  )
  const plan = await getPlan(ctx, projectKey)
  assert.deepEqual(
    plan.unphased.map((t) => [t.key, t.blockedBy]),
    [
      ['P0-T01', ['P0-T02']],
      ['P0-T02', []],
    ],
  )
  assert.deepEqual(
    plan.phases.map((p) => [p.key, p.blockedBy]),
    [
      ['P0', ['P1']],
      ['P1', []],
    ],
  )
})

test('two last tasks done concurrently deliver the phase exactly once', async () => {
  const { ctx } = await setup()
  await addPhase(ctx, { projectKey, key: 'P0', title: 'Foundation', goal: '' })
  for (const key of ['P0-T01', 'P0-T02']) {
    await addTask(ctx, { projectKey, phaseKey: 'P0', key, title: key })
    await transition(ctx, { projectKey, taskKey: key, to: 'in_progress' })
  }

  const results = await race(
    ctx,
    'phases',
    (inner) => transition(inner, { projectKey, taskKey: 'P0-T01', to: 'done' }),
    () => transition(ctx, { projectKey, taskKey: 'P0-T02', to: 'done' }),
  )

  assert.deepEqual(results, ['ok', 'ok'])
  assert.equal((await getPlan(ctx, projectKey)).phases[0].state, 'delivered')
  assert.equal((await events(ctx)).filter((e) => e.kind === 'deliver_phase').length, 1)
})

test('closePhase racing automatic delivery: delivered once, the close gets DR306', async () => {
  const { ctx } = await setup()
  await addPhase(ctx, { projectKey, key: 'P0', title: 'Foundation', goal: '' })
  await addTask(ctx, { projectKey, phaseKey: 'P0', key: 'P0-T01', title: 'A' })
  await transition(ctx, { projectKey, taskKey: 'P0-T01', to: 'in_progress' })

  const results = await race(
    ctx,
    'phases',
    (inner) => transition(inner, { projectKey, taskKey: 'P0-T01', to: 'done' }),
    () => closePhase(ctx, { projectKey, phaseKey: 'P0' }),
  )

  assert.deepEqual(results, ['ok', 'DR306'])
  assert.equal((await events(ctx)).filter((e) => e.kind === 'deliver_phase').length, 1)
})

test('closePhase racing a move of its only done task out: no delivery on the stale read', async () => {
  const { ctx } = await setup()
  await addPhase(ctx, { projectKey, key: 'P0', title: 'Foundation', goal: '' })
  await addTask(ctx, { projectKey, phaseKey: 'P0', key: 'P0-T01', title: 'A' })
  await transition(ctx, { projectKey, taskKey: 'P0-T01', to: 'in_progress' })
  await transition(ctx, { projectKey, taskKey: 'P0-T01', to: 'done' })
  await reopenPhase(ctx, { projectKey, phaseKey: 'P0', reason: 'more work' })

  const results = await race(
    ctx,
    'phases',
    (inner) => editTask(inner, { projectKey, taskKey: 'P0-T01', phaseKey: null, reason: 'unphased' }),
    () => closePhase(ctx, { projectKey, phaseKey: 'P0' }),
  )

  assert.deepEqual(results, ['ok', 'DR305'])
  assert.equal((await getPlan(ctx, projectKey)).phases[0].state, 'open')
})

test('start racing a reopen of its blocking phase: DR304 or a start against the delivered blocker, never both', async () => {
  const { ctx } = await setup()
  await addPhase(ctx, { projectKey, key: 'P0', title: 'Foundation', goal: '' })
  await addPhase(ctx, { projectKey, key: 'P1', title: 'Next', goal: '' })
  await addPhaseDependency(ctx, { projectKey, phaseKey: 'P1', blockedByKey: 'P0' })
  await addTask(ctx, { projectKey, phaseKey: 'P0', key: 'P0-T01', title: 'A' })
  await addTask(ctx, { projectKey, phaseKey: 'P1', key: 'P1-T01', title: 'B' })
  await addTask(ctx, { projectKey, phaseKey: 'P1', key: 'P1-T02', title: 'C' })
  await transition(ctx, { projectKey, taskKey: 'P0-T01', to: 'in_progress' })
  await transition(ctx, { projectKey, taskKey: 'P0-T01', to: 'done' })
  const reopen = (inner: Ctx) => reopenPhase(inner, { projectKey, phaseKey: 'P0', reason: 'regression' })

  const reopenFirst = await race(ctx, 'phases', reopen, () =>
    transition(ctx, { projectKey, taskKey: 'P1-T01', to: 'in_progress' }),
  )
  await closePhase(ctx, { projectKey, phaseKey: 'P0' })
  const startFirst = await race(
    ctx,
    'phases',
    (inner) => transition(inner, { projectKey, taskKey: 'P1-T02', to: 'in_progress' }),
    () => reopen(ctx),
  )

  assert.deepEqual(
    [reopenFirst, startFirst],
    [
      ['ok', 'DR304'],
      ['ok', 'ok'],
    ],
  )
  assert.deepEqual([(await taskOf(ctx, 'P1-T01')).state, (await taskOf(ctx, 'P1-T02')).state], ['todo', 'in_progress'])
})

test('concurrent criteria on one task get distinct positions', async () => {
  const { ctx } = await setup()
  await addTask(ctx, { projectKey, key: 'P0-T01', title: 'A' })

  const results = await race(
    ctx,
    'tasks',
    (inner) => addCriterion(inner, { projectKey, taskKey: 'P0-T01', text: 'first' }),
    () => addCriterion(ctx, { projectKey, taskKey: 'P0-T01', text: 'second' }),
  )

  assert.deepEqual(results, ['ok', 'ok'])
  const [task] = (await getPlan(ctx, projectKey)).unphased
  assert.deepEqual(
    task.criteria.map((c) => [c.position, c.text]),
    [
      [1, 'first'],
      [2, 'second'],
    ],
  )
})

test('concurrent tasks with the same key: one ok, one DR101 on /key', async () => {
  const { ctx } = await setup()

  const results = await race(
    ctx,
    'tasks',
    (inner) => addTask(inner, { projectKey, key: 'P0-T01', title: 'A' }),
    () => addTask(ctx, { projectKey, key: 'P0-T01', title: 'B' }),
  )

  assert.deepEqual(results, ['ok', 'DR101'])
})

test('a delivered phase accepts no open work → DR306', async () => {
  const { ctx } = await setup()
  await addPhase(ctx, { projectKey, key: 'P0', title: 'Foundation', goal: '' })
  await addPhase(ctx, { projectKey, key: 'P1', title: 'Next', goal: '' })
  await addTask(ctx, { projectKey, phaseKey: 'P0', key: 'P0-T01', title: 'A' })
  await addTask(ctx, { projectKey, phaseKey: 'P0', key: 'P0-T02', title: 'B' })
  await addTask(ctx, { projectKey, phaseKey: 'P1', key: 'P1-T01', title: 'C' })
  await transition(ctx, { projectKey, taskKey: 'P0-T01', to: 'in_progress' })
  await transition(ctx, { projectKey, taskKey: 'P0-T01', to: 'done' })
  await transition(ctx, { projectKey, taskKey: 'P0-T02', to: 'cancelled', reason: 'dropped' })
  assert.equal((await getPlan(ctx, projectKey)).phases[0].state, 'delivered')
  const before = (await events(ctx)).length

  await rejectsWith(addTask(ctx, { projectKey, phaseKey: 'P0', key: 'P0-T03', title: 'late' }), 'DR306')
  await rejectsWith(transition(ctx, { projectKey, taskKey: 'P0-T01', to: 'in_progress', reason: 'bug' }), 'DR306')
  await rejectsWith(transition(ctx, { projectKey, taskKey: 'P0-T02', to: 'todo', reason: 'back' }), 'DR306')
  await rejectsWith(editTask(ctx, { projectKey, taskKey: 'P1-T01', phaseKey: 'P0', reason: 'move' }), 'DR306')
  await rejectsWith(closePhase(ctx, { projectKey, phaseKey: 'P0' }), 'DR306')
  await rejectsWith(reopenPhase(ctx, { projectKey, phaseKey: 'P1', reason: 'x' }), 'DR306')
  assert.equal((await events(ctx)).length, before)

  await reopenPhase(ctx, { projectKey, phaseKey: 'P0', reason: 'regression' })
  await transition(ctx, { projectKey, taskKey: 'P0-T01', to: 'in_progress', reason: 'bug' })
})

test('listEvents rejects bad input as a promise', async () => {
  const { ctx } = await setup()

  await rejectsWith(listEvents(ctx, projectKey, { limit: 0 }), 'DR101')
  await rejectsWith(listEvents(ctx, projectKey, { afterId: 'x', limit: 10 }), 'DR101')
})

test('cancel without reason → DR104', async () => {
  const { ctx } = await setup()
  await addTask(ctx, { projectKey, key: 'P0-T01', title: 'Drop' })

  await rejectsWith(transition(ctx, { projectKey, taskKey: 'P0-T01', to: 'cancelled' }), 'DR104')
  await rejectsWith(transition(ctx, { projectKey, taskKey: 'P0-T01', to: 'cancelled', reason: '  ' }), 'DR104')
})

test('block without reason → DR104', async () => {
  const { ctx } = await setup()
  await addTask(ctx, { projectKey, key: 'P0-T01', title: 'Wait' })

  await rejectsWith(transition(ctx, { projectKey, taskKey: 'P0-T01', to: 'blocked' }), 'DR104')
})

test('last task done with criteria checked delivers the phase', async () => {
  const { ctx } = await setup()
  await addPhase(ctx, { projectKey, key: 'P0', title: 'Foundation', goal: '', criteria: ['roadmap loaded'] })
  await addTask(ctx, { projectKey, phaseKey: 'P0', key: 'P0-T01', title: 'A' })
  await addTask(ctx, { projectKey, phaseKey: 'P0', key: 'P0-T02', title: 'B' })
  await checkCriterion(ctx, { projectKey, phaseKey: 'P0', position: 1, evidence: 'gate:roadmap' })

  await transition(ctx, { projectKey, taskKey: 'P0-T01', to: 'in_progress' })
  const first = await transition(ctx, { projectKey, taskKey: 'P0-T01', to: 'done' })
  assert.equal(first.delivered, null)
  await transition(ctx, { projectKey, taskKey: 'P0-T02', to: 'cancelled', reason: 'not needed' })
  const plan = await getPlan(ctx, projectKey)
  assert.equal(plan.phases[0].state, 'delivered')
  assert.ok(plan.phases[0].deliveredAt)
  const [beforeLast, last] = (await events(ctx)).slice(-2)
  assert.deepEqual([beforeLast.kind, last.kind], ['transition', 'deliver_phase'])
  assert.equal(last.phaseKey, 'P0')
  assert.equal(last.actor, 'agent')
})

test('checking the last phase criterion delivers the phase', async () => {
  const { ctx } = await setup()
  await addPhase(ctx, { projectKey, key: 'P0', title: 'Foundation', goal: '', criteria: ['roadmap loaded'] })
  await addTask(ctx, { projectKey, phaseKey: 'P0', key: 'P0-T01', title: 'A' })
  await transition(ctx, { projectKey, taskKey: 'P0-T01', to: 'in_progress' })
  await transition(ctx, { projectKey, taskKey: 'P0-T01', to: 'done' })
  assert.equal((await getPlan(ctx, projectKey)).phases[0].state, 'open')

  const result = await checkCriterion(ctx, { projectKey, phaseKey: 'P0', position: 1, evidence: 'note:seen it' })

  assert.equal(result.delivered, 'P0')
  assert.equal((await getPlan(ctx, projectKey)).phases[0].state, 'delivered')
})

test('moving the last open task out of a phase delivers it', async () => {
  const { ctx } = await setup()
  await addPhase(ctx, { projectKey, key: 'P0', title: 'Foundation', goal: '' })
  await addPhase(ctx, { projectKey, key: 'P1', title: 'Next', goal: '' })
  await addTask(ctx, { projectKey, phaseKey: 'P0', key: 'P0-T01', title: 'A' })
  await addTask(ctx, { projectKey, phaseKey: 'P0', key: 'P0-T02', title: 'B' })
  await transition(ctx, { projectKey, taskKey: 'P0-T01', to: 'in_progress' })
  await transition(ctx, { projectKey, taskKey: 'P0-T01', to: 'done' })

  const result = await editTask(ctx, { projectKey, taskKey: 'P0-T02', phaseKey: 'P1', reason: 'later' })

  assert.equal(result.delivered, 'P0')
  assert.deepEqual(
    (await getPlan(ctx, projectKey)).phases.map((p) => [p.key, p.state]),
    [
      ['P0', 'delivered'],
      ['P1', 'open'],
    ],
  )
  const [beforeLast, last] = (await events(ctx)).slice(-2)
  assert.deepEqual([beforeLast.kind, last.kind, last.phaseKey], ['edit_task', 'deliver_phase', 'P0'])
})

test('close phase with open task → DR305', async () => {
  const { ctx } = await setup()
  await addPhase(ctx, { projectKey, key: 'P0', title: 'Foundation', goal: '' })
  await addTask(ctx, { projectKey, phaseKey: 'P0', key: 'P0-T01', title: 'A' })

  await rejectsWith(closePhase(ctx, { projectKey, phaseKey: 'P0' }), 'DR305')
})

test('invalid evidence → DR101', async () => {
  const { ctx } = await setup()
  await addTask(ctx, { projectKey, key: 'P0-T01', title: 'A', criteria: ['x'] })

  for (const evidence of ['abcdef1', 'commit:xyz1234', 'commit:abc', 'url:ftp://x', 'note:', 'gate:']) {
    await rejectsWith(checkCriterion(ctx, { projectKey, taskKey: 'P0-T01', position: 1, evidence }), 'DR101')
  }
})

test('unknown keys and other tenants → DR201', async () => {
  const { ctx, newTenant } = await setup()
  await addPhase(ctx, { projectKey, key: 'P0', title: 'A', goal: '' })
  const other = await newTenant()
  const otherCtx: Ctx = { ...ctx, tenantId: other.tenantId, actor: { id: other.human.id, kind: 'human' } }
  await createProject(otherCtx, { key: 'beta', name: 'Beta' })
  await addPhase(otherCtx, { projectKey: 'beta', key: 'B0', title: 'B', goal: '' })

  await rejectsWith(getPlan(ctx, 'beta'), 'DR201')
  await rejectsWith(addTask(ctx, { projectKey, phaseKey: 'B0', key: 'P0-T01', title: 'x' }), 'DR201')
  await rejectsWith(addTask(ctx, { projectKey, key: 'P0-T01', title: 'x', assigneeName: 'nobody' }), 'DR201')
  await rejectsWith(addTask(ctx, { projectKey, key: 'P0-T01', title: 'x', blockedBy: ['P0-T99'] }), 'DR201')
  await rejectsWith(transition(ctx, { projectKey, taskKey: 'P0-T99', to: 'in_progress' }), 'DR201')
  await rejectsWith(checkCriterion(ctx, { projectKey, phaseKey: 'P0', position: 1, evidence: 'note:x' }), 'DR201')
})

test('every mutation writes exactly one event (plus deliver_phase when it delivers)', async () => {
  const { db, newTenant } = await testDb()
  const tenant = await newTenant()
  const ctx: Ctx = { db, tenantId: tenant.tenantId, actor: { id: tenant.human.id, kind: 'human' } }
  const steps: Array<[string[], () => Promise<unknown>]> = [
    [['create_project'], () => createProject(ctx, { key: projectKey, name: 'DevRounds' })],
    [['add_phase'], () => addPhase(ctx, { projectKey, key: 'P0', title: 'A', goal: 'g', criteria: ['c'] })],
    [['add_phase'], () => addPhase(ctx, { projectKey, key: 'P1', title: 'B', goal: 'g' })],
    [['edit_phase'], () => editPhase(ctx, { projectKey, phaseKey: 'P1', title: 'B2', reason: 'rename' })],
    [['move_phase'], () => movePhase(ctx, { projectKey, phaseKey: 'P1', position: 1, reason: 'first' })],
    [['add_phase_dependency'], () => addPhaseDependency(ctx, { projectKey, phaseKey: 'P0', blockedByKey: 'P1' })],
    [['remove_phase_dependency'], () => removePhaseDependency(ctx, { projectKey, phaseKey: 'P0', blockedByKey: 'P1' })],
    [
      ['add_task'],
      () => addTask(ctx, { projectKey, phaseKey: 'P0', key: 'P0-T01', title: 'A', assigneeName: 'agent' }),
    ],
    [['add_task'], () => addTask(ctx, { projectKey, phaseKey: 'P0', key: 'P0-T02', title: 'B', parentKey: 'P0-T01' })],
    [['edit_task'], () => editTask(ctx, { projectKey, taskKey: 'P0-T02', estimateHours: 2, reason: 'sized' })],
    [['add_dependency'], () => addDependency(ctx, { projectKey, taskKey: 'P0-T02', blockedByKey: 'P0-T01' })],
    [['remove_dependency'], () => removeDependency(ctx, { projectKey, taskKey: 'P0-T02', blockedByKey: 'P0-T01' })],
    [['add_criterion'], () => addCriterion(ctx, { projectKey, taskKey: 'P0-T01', text: 'works' })],
    [
      ['edit_criterion'],
      () => editCriterion(ctx, { projectKey, taskKey: 'P0-T01', position: 1, text: 'ok', reason: 'x' }),
    ],
    [['add_link'], () => addLink(ctx, { projectKey, phaseKey: 'P0', kind: 'doc', ref: 'https://x', title: 'Spec' })],
    [['transition'], () => transition(ctx, { projectKey, taskKey: 'P0-T02', to: 'cancelled', reason: 'merged' })],
    [['transition'], () => transition(ctx, { projectKey, taskKey: 'P0-T01', to: 'in_progress' })],
    [
      ['check_criterion'],
      () => checkCriterion(ctx, { projectKey, taskKey: 'P0-T01', position: 1, evidence: 'note:ok' }),
    ],
    [['check_criterion'], () => checkCriterion(ctx, { projectKey, phaseKey: 'P0', position: 1, evidence: 'note:ok' })],
    [['transition', 'deliver_phase'], () => transition(ctx, { projectKey, taskKey: 'P0-T01', to: 'done' })],
    [['reopen_phase'], () => reopenPhase(ctx, { projectKey, phaseKey: 'P0', reason: 'more work' })],
    [['deliver_phase'], () => closePhase(ctx, { projectKey, phaseKey: 'P0' })],
  ]

  let seen = 0
  for (const [kinds, step] of steps) {
    await step()
    const all = await events(ctx)
    assert.deepEqual(
      all.slice(seen).map((e) => e.kind),
      kinds,
    )
    seen = all.length
  }
  const ids = (await events(ctx)).map((e) => BigInt(e.id))
  assert.deepEqual(
    ids,
    [...ids].sort((a, b) => (a < b ? -1 : 1)),
  )
  assert.equal((await listEvents(ctx, projectKey, { afterId: (await events(ctx)).at(-2)?.id, limit: 10 })).length, 1)
})

test('getPlan orders phases by position', async () => {
  const { ctx } = await setup()
  for (const key of ['P0', 'P1', 'P2']) await addPhase(ctx, { projectKey, key, title: key, goal: '' })
  await movePhase(ctx, { projectKey, phaseKey: 'P2', position: 1, reason: 'urgent' })
  await addPhase(ctx, { projectKey, key: 'P3', title: 'P3', goal: '', position: 2 })

  const plan = await getPlan(ctx, projectKey)

  assert.deepEqual(
    plan.phases.map((p) => [p.key, p.position]),
    [
      ['P2', 1],
      ['P3', 2],
      ['P0', 3],
      ['P1', 4],
    ],
  )
})

test('a transaction passed in ctx.trx rolls back every call on error', async () => {
  const { ctx } = await setup()

  await rejectsWith(
    withTenant(ctx.db, ctx.tenantId, async (trx) => {
      const inner = { ...ctx, trx }
      await addTask(inner, { projectKey, key: 'P0-T01', title: 'A' })
      await addTask(inner, { projectKey, key: 'P0-T02', title: 'B', blockedBy: ['P0-T01'] })
      await addDependency(inner, { projectKey, taskKey: 'P0-T01', blockedByKey: 'P0-T02' })
    }),
    'DR103',
  )

  assert.deepEqual((await getPlan(ctx, projectKey)).unphased, [])
  assert.deepEqual(
    (await events(ctx)).map((e) => e.kind),
    ['create_project'],
  )
})
