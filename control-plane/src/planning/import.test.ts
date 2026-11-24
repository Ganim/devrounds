import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DevRoundsError } from '../errors/error.ts'
import { testDb } from '../test-support/db.ts'
import { exportPlan } from './export.ts'
import { importPlan } from './import.ts'
import { parsePlanFile } from './plan-file.ts'
import type { Ctx } from './resolve.ts'
import { addCriterion, addPhase, reopenPhase } from './service.ts'
import { getPlan, listEvents } from './view.ts'

const projectKey = 'devrounds'

const SEED = `
project: { key: devrounds, name: DevRounds }
phases:
  - key: P0
    title: Foundation
    goal: Plan in the database
    criteria: [plan seeded]
    tasks:
      - key: P0-T01
        title: Repo
        description: Workspace and lint
        assignee: human
        estimate_hours: 2
        criteria: [tests pass]
      - key: P0-T02
        title: Schema
        blocked_by: [P0-T01]
        parent: P0-T01
  - key: P1
    title: Rounds
    goal: Run rounds
    blocked_by: [P0]
    tasks:
      - key: P1-T01
        title: Round loop
`

async function setup() {
  const { db, newTenant } = await testDb()
  const tenant = await newTenant()
  const ctx: Ctx = { db, tenantId: tenant.tenantId, actor: { id: tenant.human.id, kind: 'human' } }
  return { ctx, db }
}

async function eventCount(ctx: Ctx): Promise<number> {
  return (await listEvents(ctx, projectKey, { limit: 1000 })).length
}

function rejectsWith(promise: Promise<unknown>, code: string) {
  return assert.rejects(promise, (err) => {
    assert.ok(err instanceof DevRoundsError, String(err))
    assert.equal(err.code, code)
    return true
  })
}

function allTasks(plan: Awaited<ReturnType<typeof getPlan>>) {
  return [...plan.phases.flatMap((p) => p.tasks), ...plan.unphased]
}

test('first import creates everything', async () => {
  const { ctx } = await setup()
  const result = await importPlan(ctx, parsePlanFile(SEED))

  assert.deepEqual(result.created.sort(), ['P0', 'P0-T01', 'P0-T02', 'P1', 'P1-T01', 'devrounds'])
  assert.deepEqual(result.updated, [])
  assert.deepEqual(result.onlyInDb, [])
  const plan = await getPlan(ctx, projectKey)
  assert.deepEqual(
    plan.phases.map((p) => [p.key, p.position, p.blockedBy]),
    [
      ['P0', 1, []],
      ['P1', 2, ['P0']],
    ],
  )
  assert.deepEqual(
    plan.phases[0].criteria.map((c) => c.text),
    ['plan seeded'],
  )
  const [t1, t2] = plan.phases[0].tasks
  assert.deepEqual(
    [t1.description, t1.assignee, t1.estimateHours, t1.criteria.map((c) => c.text)],
    ['Workspace and lint', 'human', 2, ['tests pass']],
  )
  assert.deepEqual([t2.parent, t2.blockedBy], ['P0-T01', ['P0-T01']])
  const events = await listEvents(ctx, projectKey, { limit: 1000 })
  assert.ok(events.every((e) => e.actor === 'human' && e.actorKind === 'human'))
})

test('second import of same file: no change, no events', async () => {
  const { ctx } = await setup()
  await importPlan(ctx, parsePlanFile(SEED))
  const before = await eventCount(ctx)

  const result = await importPlan(ctx, parsePlanFile(SEED))

  assert.deepEqual(result, { created: [], updated: [], unchanged: 5, onlyInDb: [] })
  assert.equal(await eventCount(ctx), before)
})

test('edited title updates one row and writes one event', async () => {
  const { ctx } = await setup()
  await importPlan(ctx, parsePlanFile(SEED))
  const before = await eventCount(ctx)

  const result = await importPlan(ctx, parsePlanFile(SEED.replace('title: Repo', 'title: Repository')))

  assert.deepEqual(result.updated, ['P0-T01'])
  assert.equal(result.unchanged, 4)
  const events = await listEvents(ctx, projectKey, { limit: 1000 })
  assert.equal(events.length, before + 1)
  assert.deepEqual([events.at(-1)?.kind, events.at(-1)?.reason], ['edit_task', 'import'])
  const plan = await getPlan(ctx, projectKey)
  assert.equal(plan.phases[0].tasks[0].title, 'Repository')
})

test('task removed from file is reported, not deleted', async () => {
  const { ctx } = await setup()
  await importPlan(ctx, parsePlanFile(SEED))

  const result = await importPlan(
    ctx,
    parsePlanFile(SEED.replace(/tasks:\n {6}- key: P1-T01\n {8}title: Round loop\n/, 'tasks: []\n')),
  )

  assert.deepEqual(result.onlyInDb, ['P1-T01'])
  const plan = await getPlan(ctx, projectKey)
  assert.ok(allTasks(plan).some((t) => t.key === 'P1-T01'))
})

test('cycle in file → DR103 and nothing written', async () => {
  const { ctx } = await setup()
  const file = parsePlanFile(`
project: { key: devrounds, name: DevRounds }
phases:
  - key: P0
    title: Foundation
    goal: Plan
    tasks:
      - { key: P0-T01, title: A, blocked_by: [P0-T02] }
      - { key: P0-T02, title: B, blocked_by: [P0-T01] }
`)

  await rejectsWith(importPlan(ctx, file), 'DR103')
  await rejectsWith(getPlan(ctx, projectKey), 'DR201')
})

test('schema error reports line and column', () => {
  const text = [
    'project: { key: devrounds, name: DevRounds }',
    'phases:',
    '  - key: P0',
    '    title: Foundation',
    '    goal: Plan',
    '    tasks:',
    '      - key: P0-T01',
    '        title: 42',
  ].join('\n')
  assert.throws(
    () => parsePlanFile(text),
    (err) => {
      assert.ok(err instanceof DevRoundsError, String(err))
      assert.equal(err.code, 'DR101')
      assert.deepEqual([err.data.path, err.data.line, err.data.column], ['/phases/0/tasks/0/title', 8, 16])
      return true
    },
  )
  assert.throws(
    () => parsePlanFile('project: [unclosed'),
    (err) => err instanceof DevRoundsError && err.code === 'DR101' && err.data.line === 1,
  )
})

test('export then import is a no-op', async () => {
  const { ctx } = await setup()
  await importPlan(ctx, parsePlanFile(SEED))
  const before = await eventCount(ctx)

  const result = await importPlan(ctx, parsePlanFile(await exportPlan(ctx, projectKey)))

  assert.deepEqual(result, { created: [], updated: [], unchanged: 5, onlyInDb: [] })
  assert.equal(await eventCount(ctx), before)
})

test('state done without evidence → DR303', async () => {
  const { ctx } = await setup()
  const file = parsePlanFile(`
project: { key: devrounds, name: DevRounds }
phases:
  - key: P0
    title: Foundation
    goal: Plan
    tasks:
      - { key: P0-T01, title: A, criteria: [tests pass], state: done }
`)
  await rejectsWith(importPlan(ctx, file), 'DR303')
  await rejectsWith(getPlan(ctx, projectKey), 'DR201')
})

test('done task listed before its blocker imports in dependency order', async () => {
  const { ctx } = await setup()
  await importPlan(
    ctx,
    parsePlanFile(`
project: { key: devrounds, name: DevRounds }
phases:
  - key: P0
    title: Foundation
    goal: Plan
    tasks:
      - { key: P0-T02, title: B, blocked_by: [P0-T01], state: done }
      - { key: P0-T01, title: A, state: done, criteria: [{ text: tests pass, evidence: 'commit:abcdef1' }] }
      - { key: P0-T03, title: C, state: in_progress }
`),
  )
  const plan = await getPlan(ctx, projectKey)
  assert.deepEqual(
    plan.phases[0].tasks.map((t) => [t.key, t.state]),
    [
      ['P0-T01', 'done'],
      ['P0-T02', 'done'],
      ['P0-T03', 'in_progress'],
    ],
  )
  assert.equal(plan.phases[0].tasks[0].criteria[0].evidence, 'commit:abcdef1')
})

test('all five task states and a delivered phase round-trip through export', async () => {
  const { ctx } = await setup()
  const text = `
project: { key: devrounds, name: DevRounds }
phases:
  - key: P0
    title: Foundation
    goal: Plan
    state: delivered
    criteria: [{ text: seeded, evidence: 'note:seed imported' }]
    tasks:
      - { key: P0-T01, title: A, state: done, criteria: [{ text: tests pass, evidence: 'gate:test' }] }
      - { key: P0-T02, title: B, state: cancelled, reason: superseded }
  - key: P1
    title: Rounds
    goal: Run rounds
    blocked_by: [P0]
    tasks:
      - { key: P1-T01, title: A }
      - { key: P1-T02, title: B, state: in_progress }
      - { key: P1-T03, title: C, state: blocked, reason: waiting on design }
`
  await importPlan(ctx, parsePlanFile(text))
  const before = await eventCount(ctx)

  const exported = await exportPlan(ctx, projectKey)
  const result = await importPlan(ctx, parsePlanFile(exported))

  assert.deepEqual(result, { created: [], updated: [], unchanged: 7, onlyInDb: [] })
  assert.equal(await eventCount(ctx), before)
  const reparsed = parsePlanFile(exported)
  assert.equal(reparsed.phases[0].state, 'delivered')
  assert.deepEqual(
    reparsed.phases.flatMap((p) => p.tasks.map((t) => [t.key, t.state ?? 'todo', t.reason])),
    [
      ['P0-T01', 'done', undefined],
      ['P0-T02', 'cancelled', 'superseded'],
      ['P1-T01', 'todo', undefined],
      ['P1-T02', 'in_progress', undefined],
      ['P1-T03', 'blocked', 'waiting on design'],
    ],
  )
  assert.deepEqual(reparsed.phases[0].criteria, [{ text: 'seeded', evidence: 'note:seed imported' }])
  const plan = await getPlan(ctx, projectKey)
  assert.equal(plan.phases[0].state, 'delivered')
})

test('a delivered phase that is already closable closes before later phases start', async () => {
  const { ctx } = await setup()
  const file = (p1State: string) => `
project: { key: devrounds, name: DevRounds }
phases:
  - key: P0
    title: Foundation
    goal: Plan
    state: delivered
    tasks:
      - { key: P0-T01, title: A, state: done }
  - key: P1
    title: Rounds
    goal: Run rounds
    blocked_by: [P0]
    tasks:
      - { key: P1-T01, title: B, state: ${p1State} }
`
  await importPlan(ctx, parsePlanFile(file('todo')))
  await reopenPhase(ctx, { projectKey, phaseKey: 'P0', reason: 'regression' })

  const result = await importPlan(ctx, parsePlanFile(file('in_progress')))

  assert.deepEqual(result.updated, ['P0', 'P1-T01'])
  const plan = await getPlan(ctx, projectKey)
  assert.deepEqual([plan.phases[0].state, plan.phases[1].tasks[0].state], ['delivered', 'in_progress'])
})

test('a phase added without a goal survives export then import', async () => {
  const { ctx } = await setup()
  await importPlan(ctx, parsePlanFile(SEED))
  await addPhase(ctx, { projectKey, key: 'P2', title: 'Later', goal: '' })
  const before = await eventCount(ctx)

  const result = await importPlan(ctx, parsePlanFile(await exportPlan(ctx, projectKey)))

  assert.deepEqual(result, { created: [], updated: [], unchanged: 6, onlyInDb: [] })
  assert.equal(await eventCount(ctx), before)
})

test('no new criterion on a delivered phase, a task in one, or a done task', async () => {
  const { ctx } = await setup()
  const text = `
project: { key: devrounds, name: DevRounds }
phases:
  - key: P0
    title: Foundation
    goal: Plan
    state: delivered
    criteria: [{ text: seeded, evidence: 'note:seed imported' }]
    tasks:
      - { key: P0-T01, title: A, state: done }
  - key: P1
    title: Rounds
    goal: Run rounds
    tasks:
      - { key: P1-T01, title: A, state: done }
      - { key: P1-T02, title: B }
`
  await importPlan(ctx, parsePlanFile(text))
  const before = await eventCount(ctx)

  const phaseCriterion = text.replace("evidence: 'note:seed imported' }]", "evidence: 'note:seed imported' }, late]")
  await rejectsWith(importPlan(ctx, parsePlanFile(phaseCriterion)), 'DR306')
  const taskCriterion = text.replace(
    '{ key: P0-T01, title: A, state: done }',
    '{ key: P0-T01, title: A, state: done, criteria: [late] }',
  )
  await rejectsWith(importPlan(ctx, parsePlanFile(taskCriterion)), 'DR306')
  await rejectsWith(addCriterion(ctx, { projectKey, taskKey: 'P1-T01', text: 'late' }), 'DR307')
  assert.equal(await eventCount(ctx), before)
})

const WITH_LINKS = `
project: { key: devrounds, name: DevRounds }
tasks:
  - key: F-0001
    title: Loose finding
    links:
      - { kind: finding, ref: gate-1/lint, title: Lint failed }
phases:
  - key: P0
    title: Foundation
    goal: Plan in the database
    links:
      - { kind: doc, ref: docs/plan.md }
    tasks:
      - key: P0-T01
        title: Repo
        links:
          - { kind: pr, ref: '12' }
`

test('export then import of a plan with links and unphased tasks changes nothing', async () => {
  const { ctx } = await setup()
  await importPlan(ctx, parsePlanFile(WITH_LINKS))
  const before = await eventCount(ctx)

  const exported = await exportPlan(ctx, projectKey)
  const result = await importPlan(ctx, parsePlanFile(exported))

  assert.match(exported, /^tasks:\n {2}- key: F-0001/m)
  assert.deepEqual(result, { created: [], updated: [], unchanged: 3, onlyInDb: [] })
  assert.equal(await eventCount(ctx), before)
})

test('import adds a link missing by kind and ref and never adds it twice', async () => {
  const { ctx } = await setup()
  await importPlan(ctx, parsePlanFile(SEED))

  const withLink = SEED.replace('title: Repo\n', 'title: Repo\n        links: [{ kind: pr, ref: "7" }]\n')
  const first = await importPlan(ctx, parsePlanFile(withLink))
  const before = await eventCount(ctx)
  const second = await importPlan(ctx, parsePlanFile(withLink))

  assert.deepEqual(first.updated, ['P0-T01'])
  assert.deepEqual(second.updated, [])
  assert.equal(await eventCount(ctx), before)
  const plan = await getPlan(ctx, projectKey)
  assert.deepEqual(plan.phases[0].tasks[0].links, [{ kind: 'pr', ref: '7', title: null }])
})

test('a top-level task is created without a phase, and a phased task listed at top level leaves its phase', async () => {
  const { ctx } = await setup()
  await importPlan(ctx, parsePlanFile(WITH_LINKS))
  let plan = await getPlan(ctx, projectKey)
  assert.deepEqual(
    plan.unphased.map((t) => t.key),
    ['F-0001'],
  )

  const moved = WITH_LINKS.replace('tasks:\n', 'tasks:\n  - { key: P0-T01, title: Repo }\n').replace(
    /\n {6}- key: P0-T01\n {8}title: Repo\n {8}links:\n {10}- \{ kind: pr, ref: '12' \}/,
    ' []',
  )
  await importPlan(ctx, parsePlanFile(moved))

  plan = await getPlan(ctx, projectKey)
  assert.deepEqual(plan.unphased.map((t) => t.key).sort(), ['F-0001', 'P0-T01'])
  assert.deepEqual(plan.phases[0].tasks, [])
})

test('a key at top level and in a phase answers DR101 at /tasks/0/key', () => {
  const dup = WITH_LINKS.replace('key: F-0001', 'key: P0-T01')
  assert.throws(
    () => parsePlanFile(dup),
    (err) => err instanceof DevRoundsError && err.code === 'DR101' && JSON.stringify(err.data).includes('/tasks/0/key'),
  )
})
