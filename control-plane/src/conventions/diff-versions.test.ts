import assert from 'node:assert/strict'
import { test } from 'node:test'
import { diffVersions } from './diff-versions.ts'
import { type ConventionsFile, withDefaults } from './file.ts'

const file = (severity: 'warn' | 'block'): ConventionsFile => ({
  targets: [{ path: 'AGENTS.md' }],
  rules: [
    {
      key: 'engine.no-tool-names',
      section: 'Never',
      title: 'Never put a tool name in engine code',
      why: 'Providers are adapters.',
      check: { kind: 'judgment' },
      severity,
      evidence: [{ path: 'AGENTS.md', excerpt: 'Never put a vendor', role: 'source' }],
    },
  ],
})

test('a changed severity lists the rule under changed with field severity', () => {
  const diff = diffVersions(withDefaults(file('warn')), withDefaults(file('block')))
  assert.deepEqual(diff, {
    added: [],
    removed: [],
    changed: [{ key: 'engine.no-tool-names', item: 'rule', severity: 'block', fields: ['severity'] }],
    targets: { added: [], removed: [] },
  })
})
