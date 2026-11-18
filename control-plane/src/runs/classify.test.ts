import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type ClassifyInput, type ClassifyRule, classifyRun, SUMMARY_MAX_BYTES } from './classify.ts'

const exited = (exitCode: number, tail: string[] = []): ClassifyInput => ({
  reason: 'exited',
  exitCode,
  tail,
  summary: null,
})

const cases: {
  name: string
  input: ClassifyInput
  rules: ClassifyRule[]
  state: string
  failureClass: string | null
}[] = [
  { name: 'exit 0 is finished', input: exited(0), rules: [], state: 'finished', failureClass: null },
  {
    name: 'an exit code rule names the class',
    input: exited(1),
    rules: [{ class: 'check_red', exit_codes: [1] }],
    state: 'failed',
    failureClass: 'check_red',
  },
  {
    name: 'STATUS_NO_MEMORY is memory',
    input: exited(3221225495),
    rules: [{ class: 'check_red', exit_codes: [3221225495] }],
    state: 'failed',
    failureClass: 'memory',
  },
  {
    name: 'STATUS_COMMITMENT_LIMIT is memory',
    input: exited(3221225773),
    rules: [],
    state: 'failed',
    failureClass: 'memory',
  },
  {
    name: 'a timeout is a timeout',
    input: { reason: 'timeout', exitCode: 1, tail: [], summary: null },
    rules: [{ class: 'check_red', exit_codes: [1] }],
    state: 'failed',
    failureClass: 'timeout',
  },
  {
    name: 'a stop is cancelled',
    input: { reason: 'stopped', exitCode: null, tail: [], summary: null },
    rules: [],
    state: 'stopped',
    failureClass: 'cancelled',
  },
  {
    name: 'a spawn failure is the environment',
    input: { reason: 'spawn_failed', exitCode: null, tail: [], summary: 'working directory C:\\x does not exist' },
    rules: [],
    state: 'failed',
    failureClass: 'environment',
  },
  {
    name: 'an infra failure is infra',
    input: { reason: 'infra', exitCode: null, tail: [], summary: null },
    rules: [],
    state: 'failed',
    failureClass: 'infra',
  },
  {
    name: 'exit 7 without rules is unclassified',
    input: exited(7),
    rules: [],
    state: 'failed',
    failureClass: 'unclassified',
  },
  {
    name: 'a rule with both conditions needs both',
    input: exited(1, ['all good']),
    rules: [{ class: 'check_red', exit_codes: [1], log_pattern: 'FAIL' }],
    state: 'failed',
    failureClass: 'unclassified',
  },
]

for (const c of cases) {
  test(c.name, () => {
    const result = classifyRun(c.input, c.rules)
    assert.equal(result.state, c.state)
    assert.equal(result.failureClass, c.failureClass)
    if (c.state === 'finished') assert.equal(result.failureSummary, null)
  })
}

test('a log pattern rule names the class and the summary is the matching line', () => {
  const tail = [
    'Scope: all 3 workspace projects',
    ' ERR_PNPM_NO_LOCKFILE  Cannot install with "frozen-lockfile"',
    'done',
  ]
  const result = classifyRun(exited(1, tail), [{ class: 'environment', log_pattern: 'ERR_PNPM_' }])
  assert.deepEqual(result, {
    state: 'failed',
    failureClass: 'environment',
    failureSummary: ' ERR_PNPM_NO_LOCKFILE  Cannot install with "frozen-lockfile"',
  })
})

test('the summary is the last 20 lines when no pattern matched', () => {
  const tail = Array.from({ length: 30 }, (_, i) => `line ${i}`)
  const result = classifyRun(exited(7, tail), [])
  assert.equal(result.failureSummary, tail.slice(10).join('\n'))
})

test('the executor summary of a spawn failure is kept', () => {
  const result = classifyRun({ reason: 'spawn_failed', exitCode: null, tail: [], summary: 'program not found' }, [])
  assert.equal(result.failureSummary, 'program not found')
})

test('a 10 000-line tail gives a summary of at most 4096 bytes cut on a whole line', () => {
  const tail = Array.from({ length: 10_000 }, (_, i) => `${i} ${'é'.repeat(300)}`)
  const result = classifyRun(exited(7, tail), [])
  const summary = result.failureSummary ?? ''
  assert.ok(Buffer.byteLength(summary) <= SUMMARY_MAX_BYTES, `${Buffer.byteLength(summary)} bytes`)
  assert.ok(summary.length > 0)
  for (const line of summary.split('\n')) assert.ok(tail.includes(line), line.slice(0, 20))
})
