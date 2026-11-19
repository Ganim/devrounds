import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatBytes, formatDuration } from './format.ts'

test('formatBytes uses binary units', () => {
  assert.equal(formatBytes(536870912), '512 MiB')
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(1023), '1023 B')
  assert.equal(formatBytes(1536 * 1024 * 1024), '1.5 GiB')
  assert.equal(formatBytes(null), '—')
})

test('formatDuration shows minutes and zero-padded seconds', () => {
  assert.equal(formatDuration(65000), '1m 05s')
  assert.equal(formatDuration(null), '—')
  assert.equal(formatDuration(450), '450 ms')
  assert.equal(formatDuration(9500), '9.5s')
  assert.equal(formatDuration(3_725_000), '1h 02m 05s')
})
