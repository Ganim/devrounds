import assert from 'node:assert/strict'
import { test } from 'node:test'
import { phaseProgress, type TaskState } from '../planning/rules.ts'
import type { PhaseView, PlanView, TaskView } from '../planning/view.ts'
import { planShow, renderAgent } from './output.ts'

const opts = { budget: 16384, cursor: 0, moreCommand: (n: number) => `devrounds plan show --cursor ${n}` }

test('failures come first', () => {
  const out = renderAgent({ failures: ['DR302 blocked', 'hint: finish P0-T01'], body: ['line'], next: 'x' }, opts)
  assert.deepEqual(out.split('\n'), ['DR302 blocked', 'hint: finish P0-T01', 'line', 'next: x'])
})

test('body cut on a whole line at 16384 bytes with the exact more command', () => {
  // 100 lines of 199 chars + newline = 200 bytes each: 81 lines fit (16200), the 82nd would cross 16384.
  const body = Array.from({ length: 100 }, (_, i) => `${String(i).padStart(3, '0')}${'é'.repeat(98)}`)
  const lines = renderAgent({ failures: [], body, next: 'devrounds task start P0-T01' }, opts).split('\n')
  assert.equal(lines.length, 81 + 2)
  assert.equal(lines[80], body[80])
  assert.equal(lines[81], 'truncated; more: devrounds plan show --cursor 81')
  assert.ok(Buffer.byteLength(lines.slice(0, 81).join('\n')) + 1 <= 16384)

  const rest = renderAgent({ failures: [], body, next: 'n' }, { ...opts, cursor: 81 }).split('\n')
  assert.deepEqual(rest, [...body.slice(81), 'next: n'])
})

test('next is the last line', () => {
  const body = Array.from({ length: 400 }, () => 'x'.repeat(80))
  const out = renderAgent({ failures: ['f'], body, next: 'devrounds plan show' }, opts)
  assert.equal(out.split('\n').at(-1), 'next: devrounds plan show')
})

function task(key: string, state: TaskState, extra: Partial<TaskView> = {}): TaskView {
  return {
    key,
    title: `Task ${key}`,
    description: '',
    state,
    assignee: null,
    estimateHours: null,
    parent: null,
    blockedBy: [],
    startedAt: null,
    finishedAt: null,
    version: 1,
    criteria: [],
    links: [],
    ...extra,
  }
}

function phase(key: string, position: number, tasks: TaskView[], extra: Partial<PhaseView> = {}): PhaseView {
  return {
    key,
    title: `Phase ${key}`,
    goal: 'goal',
    position,
    state: 'open',
    deliveredAt: null,
    deliveredBy: null,
    progress: phaseProgress(tasks.map((t) => t.state)),
    blockedBy: [],
    criteria: [],
    links: [],
    tasks,
    ...extra,
  }
}

const plan = (phases: PhaseView[]): PlanView => ({
  project: { key: 'devrounds', name: 'DevRounds' },
  phases,
  unphased: [],
})

test('next when nothing is startable', () => {
  const view = plan([
    phase('P0', 1, [task('P0-T01', 'done')], { state: 'delivered' }),
    phase('P1', 2, [
      task('P1-T01', 'blocked'),
      task('P1-T02', 'todo', { blockedBy: ['P1-T03'] }),
      task('P1-T03', 'in_progress', {
        criteria: [{ position: 1, text: 'RLS on', checked: false, checkedAt: null, checkedBy: null, evidence: null }],
      }),
    ]),
  ])
  assert.equal(planShow(view, {}).next, 'nothing startable: 2 blocked — devrounds plan show --phase P1')

  // Once the in-progress task has every criterion checked, finishing it is the next step.
  const checked = { position: 1, text: 'RLS on', checked: true, checkedAt: null, checkedBy: null, evidence: 'note:x' }
  view.phases[1].tasks[2].criteria = [checked]
  assert.equal(planShow(view, {}).next, 'devrounds task done P1-T03')

  // A startable task wins over finishing one.
  view.phases[1].tasks.push(task('P1-T04', 'todo', { blockedBy: ['P0-T01'] }))
  assert.equal(planShow(view, {}).next, 'devrounds task start P1-T04')
})
