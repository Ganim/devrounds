import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rankMatches } from './rank.ts'
import { moveItem } from './reorder.ts'
import { formatAgo } from './time.ts'

test('rankMatches puts prefix matches before contains matches, keeping order', () => {
  const items = ['review', 'preview', 'reset', 'ship', 'pre-push']
  assert.deepEqual(
    rankMatches(items, 'Re', (s) => s),
    ['review', 'reset', 'preview', 'pre-push'],
  )
  assert.deepEqual(
    rankMatches(items, '  ', (s) => s),
    items,
  )
})

test('moveItem moves to the target index and clamps', () => {
  assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd'])
  assert.deepEqual(moveItem(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b'])
  assert.deepEqual(moveItem(['a', 'b', 'c'], 0, 99), ['b', 'c', 'a'])
  assert.deepEqual(moveItem(['a', 'b'], 5, 0), ['a', 'b'])
})

test('formatAgo is coarse, signed and falls back to the date', () => {
  const now = Date.parse('2026-11-28T12:00:00Z')
  assert.equal(formatAgo('2026-11-28T11:59:58Z', now), 'now')
  assert.equal(formatAgo('2026-11-28T11:59:18Z', now), '42s ago')
  assert.equal(formatAgo('2026-11-28T11:55:00Z', now), '5m ago')
  assert.equal(formatAgo('2026-11-28T09:00:00Z', now), '3h ago')
  assert.equal(formatAgo('2026-11-28T12:05:00Z', now), 'in 5m')
  assert.equal(formatAgo('2026-10-01T12:00:00Z', now), '2026-10-01')
})
