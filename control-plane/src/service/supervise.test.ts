import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextDelay } from './supervise.ts'

test('restart delay doubles from 1 s to 30 s and starts over after 5 min up', () => {
  const delays: number[] = []
  let delay: number | null = null
  for (let i = 0; i < 7; i++) {
    delay = nextDelay(delay, 1_000)
    delays.push(delay)
  }
  assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000])
  assert.equal(nextDelay(30_000, 5 * 60_000), 1_000)
})
