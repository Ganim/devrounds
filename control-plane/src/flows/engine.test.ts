import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { sql } from 'kysely'
import { DevRoundsError } from '../errors/error.ts'
import type { RunEvent } from '../executor/protocol.ts'
import { putJobType } from '../job-types/service.ts'
import type { Ctx } from '../planning/resolve.ts'
import { addTask, createProject } from '../planning/service.ts'
import { applyRunEvent } from '../runs/record.ts'
import { withTenant } from '../tenancy/scope.ts'
import { testDb } from '../test-support/db.ts'
import type { AskSchema, FlowDocument } from './document.ts'
import { wakeDueFlowWaits } from './engine.ts'
import { cancelFlowRun, type FlowRunView, flowRunView, putFlow, resumeFlowRun, startFlowRun } from './service.ts'

const projectKey = 'devrounds'
const log = { warn() {}, error() {} }

const failsWith =
  (code: string, data: Record<string, unknown> = {}) =>
  (err: unknown) =>
    err instanceof DevRoundsError &&
    err.code === code &&
    Object.entries(data).every(([key, value]) => err.data[key] === value)

// build runs the synthetic job type `check` (exit 1 is check_red); a red build waits and builds again, at most 3
// builds; a green one passes the branch to finish.
const LOOP: FlowDocument = {
  key: 'loop',
  start: 'build',
  nodes: {
    build: {
      kind: 'job',
      job_type: 'check',
      cwd: '{{input.repo}}',
      args: ['--tag', '{{input.tag}}'],
      max_visits: 3,
      next: { done: 'route', failed: 'pause' },
    },
    pause: { kind: 'wait', duration_s: 60, next: { done: 'build' } },
    route: {
      kind: 'branch',
      cases: [{ field: 'data.exit_code', equals: 0, label: 'green' }],
      next: { green: 'finish', default: 'stop' },
    },
    stop: { kind: 'park', reason: 'unexpected result for {{input.tag}}' },
    finish: { kind: 'finish' },
  },
}

const INPUT = { repo: 'C:\\src\\app', tag: 'FLOWS-1' }

async function setup() {
  const t = await testDb()
  const tenant = await t.newTenant()
  const ctx: Ctx = { db: t.db, tenantId: tenant.tenantId, actor: { id: tenant.human.id, kind: 'human' } }
  await createProject(ctx, { key: projectKey, name: 'DevRounds' })
  await addTask(ctx, { projectKey, key: 'P4-T16', title: 'flow engine' })
  await putJobType(ctx, projectKey, {
    key: 'check',
    command: { program: 'node', args: ['check'] },
    args_from_job: true,
    classify: [{ class: 'check_red', exit_codes: [1] }],
  })
  const machineId = await withTenant(t.db, tenant.tenantId, async (trx) => {
    const row = await trx
      .insertInto('machines')
      .values({ tenant_id: tenant.tenantId, name: 'build-01', token_hash: randomBytes(32), os: 'windows', executor_version: '0.1.0' })
      .returning('id')
      .executeTakeFirstOrThrow()
    return row.id
  })
  const event = (e: RunEvent) => applyRunEvent(ctx, machineId, e, new Date())
  // Runs `runId` on build-01 to its end with exit code `exit`.
  const end = async (runId: string, exit: number) => {
    await t.admin
      .updateTable('runs')
      .set({ state: 'offered', machine_id: machineId, offered_at: sql<Date>`now()` })
      .where('id', '=', runId)
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
  const show = (id: string) => flowRunView(ctx, projectKey, id)
  // The run of the open job node.
  const waitingRun = (view: FlowRunView) => {
    const open = view.nodes.at(-1)
    assert.equal(open?.kind, 'job', `expected an open job node, got ${JSON.stringify(open)}`)
    return open?.run?.id as string
  }
  // Wakes waits as if their time had come (60 s and a bit later).
  const wake = () => wakeDueFlowWaits(t.db, new Date(Date.now() + 61_000), log)
  return { t, tenant, ctx, end, show, waitingRun, wake }
}

const trail = (view: FlowRunView) => view.nodes.map((n) => `${n.node}#${n.visit}:${n.outcome ?? 'open'}`)

test('a loop bounded by max_visits runs end to end and parks one visit past its bound', async () => {
  const s = await setup()
  await putFlow(s.ctx, projectKey, LOOP)
  let view = await startFlowRun(s.ctx, projectKey, 'loop', { task: 'P4-T16', input: INPUT })
  assert.equal(view.state, 'running')
  for (let build = 1; build <= 3; build++) {
    await s.end(s.waitingRun(view), 1)
    view = await s.show(view.id)
    assert.equal(view.nodes.at(-1)?.node, 'pause')
    assert.ok(view.nodes.at(-1)?.wakeAt, 'the wait has a wake time')
    // Not due yet: the real clock moves nothing.
    assert.equal(await wakeDueFlowWaits(s.t.db, new Date(), log), 0)
    assert.equal(await s.wake(), 1)
    view = await s.show(view.id)
  }
  assert.equal(view.state, 'parked')
  assert.equal(view.reason, 'node build reached max_visits 3')
  assert.deepEqual(trail(view), [
    'build#1:failed',
    'pause#1:done',
    'build#2:failed',
    'pause#2:done',
    'build#3:failed',
    'pause#3:done',
  ])
  assert.deepEqual(view.visits, { build: 3, pause: 3 })
  assert.deepEqual(view.nodes[0].data, { run: view.nodes[0].run?.id, exit_code: 1, failure_class: 'check_red' })

  // Every build is a job of the run's task, with the templates filled from the input.
  const jobs = await s.t.admin
    .selectFrom('jobs as j')
    .innerJoin('tasks as t', 't.id', 'j.task_id')
    .select(['t.key', 'j.cwd', 'j.args'])
    .where('j.tenant_id', '=', s.tenant.tenantId)
    .execute()
  assert.deepEqual(
    jobs,
    [1, 2, 3].map(() => ({ key: 'P4-T16', cwd: 'C:\\src\\app', args: ['--tag', 'FLOWS-1'] })),
  )
  const events = await s.t.admin
    .selectFrom('plan_events')
    .select(['kind', 'reason', 'data'])
    .where('tenant_id', '=', s.tenant.tenantId)
    .where('kind', 'like', 'flow_run_%')
    .orderBy('id')
    .execute()
  assert.deepEqual(events, [
    { kind: 'flow_run_start', reason: null, data: { flow: 'loop', version: 1, run: view.id, source_key: null } },
    {
      kind: 'flow_run_end',
      reason: 'node build reached max_visits 3',
      data: { flow: 'loop', run: view.id, state: 'parked' },
    },
  ])
})

test('a red build waits and builds again; a green one branches to finish', async () => {
  const s = await setup()
  await putFlow(s.ctx, projectKey, LOOP)
  let view = await startFlowRun(s.ctx, projectKey, 'loop', { task: 'P4-T16', input: INPUT })
  await s.end(s.waitingRun(view), 1)
  await s.wake()
  view = await s.show(view.id)
  await s.end(s.waitingRun(view), 0)
  view = await s.show(view.id)
  assert.equal(view.state, 'done')
  assert.ok(view.endedAt)
  assert.deepEqual(trail(view), ['build#1:failed', 'pause#1:done', 'build#2:done', 'route#1:green', 'finish#1:done'])
})

test('a label with no edge parks the run, and a park node ends it with its reason', async () => {
  const s = await setup()
  const doc: FlowDocument = {
    key: 'strict',
    start: 'build',
    nodes: {
      build: { kind: 'job', job_type: 'check', cwd: 'C:\\src', next: { done: 'route' } },
      route: { kind: 'branch', cases: [{ field: 'label', equals: 'never', label: 'never' }], next: { default: 'stop' } },
      stop: { kind: 'park', reason: 'needs {{input.who}}' },
    },
  }
  await putFlow(s.ctx, projectKey, doc)
  const red = await startFlowRun(s.ctx, projectKey, 'strict', { task: 'P4-T16', input: { who: 'a person' } })
  await s.end(s.waitingRun(red), 1)
  const parked = await s.show(red.id)
  assert.deepEqual([parked.state, parked.reason], ['parked', 'node build has no edge for outcome failed'])

  const green = await startFlowRun(s.ctx, projectKey, 'strict', { task: 'P4-T16', input: { who: 'a person' } })
  await s.end(s.waitingRun(green), 0)
  const ended = await s.show(green.id)
  assert.deepEqual([ended.state, ended.reason], ['parked', 'needs a person'])
  assert.deepEqual(trail(ended), ['build#1:done', 'route#1:default', 'stop#1:parked'])
})

test('one live flow run per (flow, source key): a second start is DR314 until the first ends', async () => {
  const s = await setup()
  await putFlow(s.ctx, projectKey, LOOP)
  const start = (sourceKey?: string) =>
    startFlowRun(s.ctx, projectKey, 'loop', { task: 'P4-T16', input: INPUT, sourceKey })
  const first = await start('linear:FLOWS-1')
  assert.equal(first.sourceKey, 'linear:FLOWS-1')
  await assert.rejects(start('linear:FLOWS-1'), failsWith('DR314', { flow: 'loop', source: 'linear:FLOWS-1', run: first.id }))
  // Another source key, or none, is another run.
  await start('linear:FLOWS-2')
  await start()
  await start()
  // A new version does not lift the lock: it is per flow key.
  await putFlow(s.ctx, projectKey, { ...LOOP, nodes: { ...LOOP.nodes, pause: { ...LOOP.nodes.pause, duration_s: 30 } } })
  await assert.rejects(start('linear:FLOWS-1'), failsWith('DR314'))

  const { view, liveRun } = await cancelFlowRun(s.ctx, projectKey, first.id)
  assert.equal(view.state, 'cancelled')
  assert.equal(liveRun, s.waitingRun(first))
  assert.deepEqual(trail(view), ['build#1:cancelled'])
  const again = await start('linear:FLOWS-1')
  assert.equal(again.version, 2)

  // The cancelled run's job ending later moves nothing.
  await s.end(liveRun as string, 1)
  assert.deepEqual(trail(await s.show(first.id)), ['build#1:cancelled'])
  // Cancelling again answers the run as it is.
  assert.equal((await cancelFlowRun(s.ctx, projectKey, first.id)).liveRun, null)
})

test('the task source key is the default source key', async () => {
  const s = await setup()
  await addTask(s.ctx, { projectKey, key: 'P4-T17', title: 'card', sourceKey: 'linear:FLOWS-9' })
  await putFlow(s.ctx, projectKey, LOOP)
  const run = await startFlowRun(s.ctx, projectKey, 'loop', { task: 'P4-T17', input: INPUT })
  assert.equal(run.sourceKey, 'linear:FLOWS-9')
  await assert.rejects(
    startFlowRun(s.ctx, projectKey, 'loop', { task: 'P4-T17', input: INPUT }),
    failsWith('DR314', { run: run.id }),
  )
})

test('a start checks the input, the job types and the flow, and leaves nothing behind', async () => {
  const s = await setup()
  await assert.rejects(
    startFlowRun(s.ctx, projectKey, 'loop', { task: 'P4-T16', input: INPUT }),
    failsWith('DR201', { kind: 'flow', key: 'loop' }),
  )
  await putFlow(s.ctx, projectKey, LOOP)
  await assert.rejects(
    startFlowRun(s.ctx, projectKey, 'loop', { task: 'P4-T16', input: { repo: 'C:\\src' } }),
    failsWith('DR101', { path: '/input/tag', reason: 'is required by /nodes/build/args/1' }),
  )
  await putFlow(s.ctx, projectKey, { ...LOOP, nodes: { ...LOOP.nodes, build: { ...LOOP.nodes.build, job_type: 'gone' } } })
  await assert.rejects(
    startFlowRun(s.ctx, projectKey, 'loop', { task: 'P4-T16', input: INPUT }),
    failsWith('DR201', { kind: 'job type', key: 'gone' }),
  )
  const runs = await s.t.admin.selectFrom('flow_runs').select('id').where('tenant_id', '=', s.tenant.tenantId).execute()
  assert.deepEqual(runs, [])
})

test('flow set stores a new version only when the document changes; a run keeps its version', async () => {
  const s = await setup()
  const v1 = await putFlow(s.ctx, projectKey, LOOP)
  assert.deepEqual([v1.version, v1.created], [1, true])
  // Same document, keys in another order: same version.
  const { nodes, start, key } = LOOP
  const same = await putFlow(s.ctx, projectKey, { nodes, start, key })
  assert.deepEqual([same.version, same.created, same.sha], [1, false, v1.sha])
  let run = await startFlowRun(s.ctx, projectKey, 'loop', { task: 'P4-T16', input: INPUT })
  const v2 = await putFlow(s.ctx, projectKey, {
    ...LOOP,
    nodes: { ...LOOP.nodes, build: { ...LOOP.nodes.build, next: { done: 'finish', failed: 'finish' } } },
  })
  assert.deepEqual([v2.version, v2.created], [2, true])
  // The running run still follows version 1: a red build waits.
  await s.end(s.waitingRun(run), 1)
  run = await s.show(run.id)
  assert.deepEqual([run.version, run.nodes.at(-1)?.node], [1, 'pause'])
  await assert.rejects(putFlow(s.ctx, projectKey, { ...LOOP, start: 'nowhere' }), failsWith('DR101', { path: '/start' }))
})

test('a flow run of another tenant is not found', async () => {
  const s = await setup()
  await putFlow(s.ctx, projectKey, LOOP)
  const run = await startFlowRun(s.ctx, projectKey, 'loop', { task: 'P4-T16', input: INPUT })
  const other = await setup()
  await assert.rejects(other.show(run.id), failsWith('DR201', { kind: 'flow run' }))
  await assert.rejects(cancelFlowRun(other.ctx, projectKey, run.id), failsWith('DR201', { kind: 'flow run' }))
})

test('a park node with ask resumes with a checked answer that the next node reads', async () => {
  const s = await setup()
  const ASK: AskSchema = {
    type: 'object',
    properties: { action: { type: 'string', enum: ['retry', 'drop'] }, note: { type: 'string', maxLength: 20 } },
    required: ['action'],
  }
  const doc: FlowDocument = {
    key: 'ask',
    start: 'build',
    nodes: {
      build: { kind: 'job', job_type: 'check', cwd: 'C:\\src', max_visits: 2, next: { done: 'finish', failed: 'decide' } },
      decide: { kind: 'park', reason: 'build red', ask: ASK, next: { resumed: 'route' } },
      route: {
        kind: 'branch',
        cases: [{ field: 'data.action', equals: 'retry', label: 'retry' }],
        next: { retry: 'build', default: 'finish' },
      },
      finish: { kind: 'finish' },
    },
  }
  await putFlow(s.ctx, projectKey, doc)
  const started = await startFlowRun(s.ctx, projectKey, 'ask', { task: 'P4-T16' })
  await s.end(s.waitingRun(started), 1)
  let view = await s.show(started.id)
  assert.deepEqual([view.state, view.reason], ['parked', 'build red'])
  assert.deepEqual(view.nodes.at(-1)?.data, { reason: 'build red', ask_schema: ASK })

  const resume = (answer: Record<string, unknown>, ctx = s.ctx) => resumeFlowRun(ctx, projectKey, started.id, { answer })
  await assert.rejects(resume({}), failsWith('DR101', { path: '/answer/action' }))
  await assert.rejects(resume({ action: 'later' }), failsWith('DR101', { path: '/answer/action' }))
  await assert.rejects(resume({ action: 'retry', typo: 1 }), failsWith('DR101', { path: '/answer/typo' }))
  const agent: Ctx = { ...s.ctx, actor: { id: s.tenant.agent.id, kind: 'agent' } }
  await assert.rejects(resume({ action: 'retry' }, agent), failsWith('DR453'))

  view = await resume({ action: 'retry', note: 'flaky' })
  assert.equal(view.state, 'running')
  assert.deepEqual(view.nodes.at(-3)?.data, { reason: 'build red', ask_schema: ASK, answer: { action: 'retry', note: 'flaky' } })
  assert.deepEqual(trail(view), ['build#1:failed', 'decide#1:parked', 'route#1:retry', 'build#2:open'])
  // Running again: nothing to resume.
  await assert.rejects(resume({ action: 'drop' }), failsWith('DR203', { state: 'running' }))
  await s.end(s.waitingRun(view), 0)
  view = await s.show(view.id)
  assert.equal(view.state, 'done')
  const kinds = await s.t.admin
    .selectFrom('plan_events')
    .select('kind')
    .where('tenant_id', '=', s.tenant.tenantId)
    .where('kind', 'like', 'flow_run_%')
    .orderBy('id')
    .execute()
  assert.deepEqual(
    kinds.map((k) => k.kind),
    ['flow_run_start', 'flow_run_end', 'flow_run_resume', 'flow_run_end'],
  )
})

test('a run parked by max_visits, by a park without a resume edge, or not parked has nowhere to resume', async () => {
  const s = await setup()
  await putFlow(s.ctx, projectKey, LOOP)
  const looped = await startFlowRun(s.ctx, projectKey, 'loop', { task: 'P4-T16', input: INPUT })
  for (let build = 1; build <= 3; build++) {
    await s.end(s.waitingRun(await s.show(looped.id)), 1)
    await s.wake()
  }
  assert.equal((await s.show(looped.id)).reason, 'node build reached max_visits 3')
  await assert.rejects(resumeFlowRun(s.ctx, projectKey, looped.id, {}), failsWith('DR203', { state: 'parked' }))

  // LOOP's `stop` parks without a next edge: a green build whose exit code is not 0 cannot happen, so use a flow
  // that reaches it directly.
  await putFlow(s.ctx, projectKey, { key: 'stop', start: 'stop', nodes: { stop: { kind: 'park', reason: 'no' } } })
  const stopped = await startFlowRun(s.ctx, projectKey, 'stop', { task: 'P4-T16' })
  assert.equal(stopped.state, 'parked')
  await assert.rejects(resumeFlowRun(s.ctx, projectKey, stopped.id, {}), failsWith('DR203', { state: 'parked' }))

  await putFlow(s.ctx, projectKey, { key: 'done', start: 'end', nodes: { end: { kind: 'finish' } } })
  const done = await startFlowRun(s.ctx, projectKey, 'done', { task: 'P4-T16' })
  assert.equal(done.state, 'done')
  await assert.rejects(resumeFlowRun(s.ctx, projectKey, done.id, {}), failsWith('DR203', { state: 'done' }))
})
