import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DevRoundsError } from '../errors/error.ts'
import { checkGraph } from './graph.ts'

const error = (code: string, data: Record<string, unknown>) => (err: unknown) =>
  err instanceof DevRoundsError && err.code === code && assert.deepEqual(err.data, data) === undefined

test('a diamond is accepted', () => {
  assert.doesNotThrow(() =>
    checkGraph('b1', [
      { ref: 'a', dependsOn: [] },
      { ref: 'b', dependsOn: ['a'] },
      { ref: 'c', dependsOn: ['a'] },
      { ref: 'd', dependsOn: ['b', 'c'] },
    ]),
  )
})

test('a two-job cycle answers DR152 with cycle "a → b → a"', () => {
  assert.throws(
    () =>
      checkGraph('b1', [
        { ref: 'a', dependsOn: ['b'] },
        { ref: 'b', dependsOn: ['a'] },
      ]),
    error('DR152', { batch: 'b1', cycle: 'a → b → a' }),
  )
})

test('a self dependency answers DR152', () => {
  assert.throws(
    () => checkGraph('b1', [{ ref: 'a', dependsOn: ['a'] }]),
    error('DR152', { batch: 'b1', cycle: 'a → a' }),
  )
})

test('an unknown ref answers DR101 at /jobs/1/depends_on/0', () => {
  assert.throws(
    () =>
      checkGraph('b1', [
        { ref: 'a', dependsOn: [] },
        { ref: 'b', dependsOn: ['z'] },
      ]),
    (err: unknown) => err instanceof DevRoundsError && err.code === 'DR101' && err.data.path === '/jobs/1/depends_on/0',
  )
})

test('a duplicate ref answers DR101 at /jobs/1/ref', () => {
  assert.throws(
    () =>
      checkGraph('b1', [
        { ref: 'a', dependsOn: [] },
        { ref: 'a', dependsOn: [] },
      ]),
    (err: unknown) => err instanceof DevRoundsError && err.code === 'DR101' && err.data.path === '/jobs/1/ref',
  )
})
