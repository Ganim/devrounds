import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findDocumentIssue } from './examples-check.ts'
import type { ConventionsFile } from './file.ts'

test('a pattern that backtracks past the budget is an issue at its forbid, and the event loop stays free', async () => {
  const rule = (key: string, forbid: string, bad: string): ConventionsFile['rules'][number] => ({
    key,
    section: 'Never',
    title: key,
    why: key,
    paths: ['**'],
    check: { kind: 'pattern', forbid },
    examples: { bad: [bad] },
    evidence: [{ path: 'AGENTS.md', excerpt: 'x', role: 'source' }],
  })
  // `(a+)+$` on a run of a's with a trailing `!` backtracks exponentially: it never ends within the budget.
  const document: ConventionsFile = {
    targets: [{ path: 'AGENTS.md' }],
    rules: [rule('fine', 'TODO', '// TODO'), rule('slow', '(a+)+$', `${'a'.repeat(900)}!`)],
  }
  let ticks = 0
  const timer = setInterval(() => ticks++, 10)
  try {
    assert.deepEqual(await findDocumentIssue(document, 100), {
      path: '/rules/1/check/forbid',
      reason: 'the examples went over the 100 ms budget while this rule ran; make its pattern simpler',
    })
  } finally {
    clearInterval(timer)
  }
  assert.ok(ticks > 0)
})
