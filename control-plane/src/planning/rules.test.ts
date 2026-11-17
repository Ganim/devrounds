import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { DevRoundsError } from '../errors/error.ts'
import { checkPhaseClose, checkTransition, isBlockerOpen, phaseProgress, type TaskState, wouldCycle } from './rules.ts'

type Input = Parameters<typeof checkTransition>[0]

function ok(i: Partial<Input> & Pick<Input, 'from' | 'to'>): Input {
  return { openBlockers: [], openCriteria: 0, blockingPhasesOpen: [], ...i }
}

function codeOf(fn: () => void): { code: string; data: Record<string, unknown> } {
  try {
    fn()
  } catch (e) {
    assert.ok(e instanceof DevRoundsError)
    return { code: e.code, data: e.data }
  }
  return assert.fail('expected a DevRoundsError')
}

describe('checkTransition', () => {
  const allowed: Array<[TaskState, TaskState, string?]> = [
    ['todo', 'in_progress'],
    ['todo', 'blocked', 'waiting'],
    ['todo', 'cancelled', 'dropped'],
    ['in_progress', 'done'],
    ['in_progress', 'blocked', 'waiting'],
    ['in_progress', 'todo'],
    ['in_progress', 'cancelled', 'dropped'],
    ['blocked', 'todo'],
    ['blocked', 'in_progress'],
    ['blocked', 'cancelled', 'dropped'],
    ['done', 'in_progress', 'regression'],
    ['cancelled', 'todo', 'back on'],
  ]
  for (const [from, to, reason] of allowed) {
    test(`${from} -> ${to} is allowed`, () => {
      checkTransition(ok({ from, to, reason }))
    })
  }

  test('anything else is DR301 with from and to', () => {
    const r = codeOf(() => checkTransition(ok({ from: 'todo', to: 'done' })))
    assert.equal(r.code, 'DR301')
    assert.deepEqual(r.data, { from: 'todo', to: 'done' })
    assert.equal(codeOf(() => checkTransition(ok({ from: 'done', to: 'done' }))).code, 'DR301')
    assert.equal(codeOf(() => checkTransition(ok({ from: 'cancelled', to: 'in_progress' }))).code, 'DR301')
  })

  test('blocked, cancelled, reopen and restore need a reason', () => {
    for (const [from, to] of [
      ['todo', 'blocked'],
      ['todo', 'cancelled'],
      ['done', 'in_progress'],
      ['cancelled', 'todo'],
    ] as const) {
      assert.equal(codeOf(() => checkTransition(ok({ from, to }))).code, 'DR104')
      assert.equal(codeOf(() => checkTransition(ok({ from, to, reason: '   ' }))).code, 'DR104')
    }
  })

  test('open blockers stop in_progress with DR302', () => {
    const r = codeOf(() => checkTransition(ok({ from: 'todo', to: 'in_progress', openBlockers: ['P0-T01'] })))
    assert.equal(r.code, 'DR302')
    assert.deepEqual(r.data, { blockers: ['P0-T01'] })
  })

  test('cancelled blocker does not block', () => {
    assert.equal(isBlockerOpen('cancelled'), false)
    assert.equal(isBlockerOpen('done'), false)
    assert.equal(isBlockerOpen('todo'), true)
    assert.equal(isBlockerOpen('blocked'), true)
  })

  test('blocking phases not delivered stop in_progress with DR304', () => {
    const r = codeOf(() => checkTransition(ok({ from: 'todo', to: 'in_progress', blockingPhasesOpen: ['P0'] })))
    assert.equal(r.code, 'DR304')
    assert.deepEqual(r.data, { phases: ['P0'] })
  })

  test('open criteria stop done with DR303', () => {
    const r = codeOf(() => checkTransition(ok({ from: 'in_progress', to: 'done', openCriteria: 2 })))
    assert.equal(r.code, 'DR303')
    assert.deepEqual(r.data, { count: 2 })
  })

  test('order: DR301, then DR104, then DR302, DR304, DR303', () => {
    assert.equal(codeOf(() => checkTransition(ok({ from: 'todo', to: 'done', openCriteria: 1 }))).code, 'DR301')
    assert.equal(
      codeOf(() => checkTransition(ok({ from: 'done', to: 'in_progress', openBlockers: ['x'] }))).code,
      'DR104',
    )
    assert.equal(
      codeOf(() =>
        checkTransition(ok({ from: 'todo', to: 'in_progress', openBlockers: ['x'], blockingPhasesOpen: ['P0'] })),
      ).code,
      'DR302',
    )
  })
})

describe('wouldCycle', () => {
  const edges: Array<[string, string]> = [
    ['a', 'b'],
    ['b', 'c'],
  ]
  test('closing a loop is a cycle', () => assert.equal(wouldCycle(edges, ['c', 'a']), true))
  test('a shortcut is not', () => assert.equal(wouldCycle(edges, ['a', 'c']), false))
  test('self edge is a cycle', () => assert.equal(wouldCycle([], ['a', 'a']), true))
})

describe('phaseProgress', () => {
  test('counts and percent exclude cancelled', () => {
    assert.deepEqual(phaseProgress(['done', 'done', 'cancelled', 'todo']), {
      done: 2,
      inProgress: 0,
      todo: 1,
      blocked: 0,
      cancelled: 1,
      total: 4,
      percent: 67,
    })
  })
  test('empty or all cancelled is 0', () => {
    assert.equal(phaseProgress([]).percent, 0)
    assert.equal(phaseProgress(['cancelled']).percent, 0)
  })
})

describe('checkPhaseClose', () => {
  test('all done or cancelled with one done closes', () => {
    checkPhaseClose({ states: ['done', 'cancelled'], openCriteria: 0 })
  })
  test('phase with zero tasks cannot close', () => {
    const r = codeOf(() => checkPhaseClose({ states: [], openCriteria: 0 }))
    assert.equal(r.code, 'DR305')
    assert.equal(r.data.noDoneTask, true)
  })
  test('only cancelled cannot close', () => {
    assert.equal(codeOf(() => checkPhaseClose({ states: ['cancelled'], openCriteria: 0 })).code, 'DR305')
  })
  test('open tasks and open criteria are reported', () => {
    const r = codeOf(() => checkPhaseClose({ states: ['done', 'todo', 'blocked'], openCriteria: 2 }))
    assert.equal(r.code, 'DR305')
    assert.deepEqual(r.data, { openTasks: 2, openCriteria: 2, noDoneTask: false })
  })
})
