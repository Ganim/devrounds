import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DevRoundsError } from '../errors/error.ts'
import { findFlowIssue, parseFlowFile } from './document.ts'

const job = (next: Record<string, string>, extra: object = {}) => ({
  kind: 'job',
  job_type: 'check',
  cwd: 'C:\\src',
  next,
  ...extra,
})

const doc = (nodes: Record<string, unknown>, start = 'a') => ({ key: 'flow', start, nodes })

test('a cycle must pass through a node with max_visits', () => {
  const unbounded = doc({ a: job({ done: 'b' }), b: { kind: 'wait', duration_s: 5, next: { done: 'a' } } })
  assert.deepEqual(findFlowIssue(unbounded), {
    path: '/nodes/a/max_visits',
    reason: 'is required on a node of the cycle a → b → a, so the loop is bounded',
  })
  const bounded = doc({ a: job({ done: 'b' }), b: { kind: 'wait', duration_s: 5, max_visits: 3, next: { done: 'a' } } })
  assert.equal(findFlowIssue(bounded), null)
  // A branch looping on itself is a cycle too.
  const self = doc({ a: { kind: 'branch', cases: [{ field: 'label', equals: 'x', label: 'x' }], next: { x: 'a' } } })
  assert.equal(findFlowIssue(self)?.path, '/nodes/a/max_visits')
})

test('edges, the start, templates, kinds and ask fields are checked with their path', () => {
  const cases: [unknown, string][] = [
    [doc({ a: job({ done: 'nowhere' }) }), '/nodes/a/next/done'],
    [doc({ a: { kind: 'finish' } }, 'b'), '/start'],
    [doc({ a: job({}, { cwd: '{{steps.x}}' }) }), '/nodes/a/cwd'],
    [doc({ a: { kind: 'sleep' } }), '/nodes/a/kind'],
    [doc({ a: { kind: 'toString' } }), '/nodes/a/kind'],
    [doc({ a: { kind: 'wait', duration_s: 0 } }), '/nodes/a/duration_s'],
    [doc({ a: job({}, { extra: 1 }) }), '/nodes/a/extra'],
    [
      doc({ a: { kind: 'park', reason: 'r', ask: { type: 'object', properties: {}, required: ['who'] } } }),
      '/nodes/a/ask/required/0',
    ],
  ]
  for (const [value, path] of cases) assert.equal(findFlowIssue(value)?.path, path, JSON.stringify(value))
})

test('a flow file points a problem at its line', () => {
  const text =
    'key: flow\nstart: a\nnodes:\n  a:\n    kind: job\n    job_type: check\n    cwd: x\n    next: { done: b }\n'
  assert.throws(
    () => parseFlowFile(text),
    (err) =>
      err instanceof DevRoundsError &&
      err.code === 'DR101' &&
      err.data.path === '/nodes/a/next/done' &&
      err.data.line === 8,
  )
})
