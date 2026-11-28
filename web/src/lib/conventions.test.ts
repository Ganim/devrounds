import assert from 'node:assert/strict'
import { test } from 'node:test'
import { diffEntries } from './conventions.ts'

test('diffEntries puts removed and changed blocking rules first', () => {
  const entries = diffEntries({
    added: [{ key: 'new.block', item: 'rule', severity: 'block' }],
    removed: [
      { key: 'gone.warn', item: 'rule', severity: 'warn' },
      { key: 'gone.block', item: 'rule', severity: 'block' },
    ],
    changed: [
      { key: 'fact.layout', item: 'fact', severity: null, fields: ['text'] },
      { key: 'demoted', item: 'rule', severity: 'warn', fields: ['severity'] },
    ],
    targets: { added: [], removed: [] },
  })
  assert.deepEqual(
    entries.map((e) => `${e.verb} ${e.key}`),
    ['removed gone.block', 'changed demoted', 'removed gone.warn', 'changed fact.layout', 'added new.block'],
  )
})
