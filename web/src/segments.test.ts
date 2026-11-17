import assert from 'node:assert/strict'
import { test } from 'node:test'
import { segments } from './segments.ts'

const progress = (p: Partial<Parameters<typeof segments>[0]>) => ({
  done: 0,
  inProgress: 0,
  todo: 0,
  blocked: 0,
  cancelled: 0,
  total: 0,
  percent: 0,
  ...p,
})

test('segments widths sum to 100 and skip zero counts', () => {
  const result = segments(progress({ done: 1, inProgress: 1, todo: 1, total: 3 }))
  assert.deepEqual(
    result.map((s) => s.state),
    ['done', 'in_progress', 'todo'],
  )
  assert.equal(
    result.reduce((sum, s) => sum + s.widthPct, 0),
    100,
  )
})

test('segments puts cancelled last and gives an empty phase no segments', () => {
  const result = segments(progress({ cancelled: 1, done: 2, blocked: 1, total: 4 }))
  assert.equal(result.at(-1)?.state, 'cancelled')
  assert.deepEqual(segments(progress({})), [])
})
