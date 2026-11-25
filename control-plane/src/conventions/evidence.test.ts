import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { removeDir } from '../test-support/remove-dir.ts'
import { inspectEvidence, verifyEvidence } from './evidence.ts'
import type { Evidence } from './file.ts'

const SCRATCH = join(fileURLToPath(new URL('../../../', import.meta.url)), '.superpowers', 'tmp')
let repo: string

before(async () => {
  await mkdir(SCRATCH, { recursive: true })
  repo = await mkdtemp(join(SCRATCH, 'evidence-'))
  await writeFile(join(repo, 'AGENTS.md'), '# Rules\r\n\r\nNever call sync fs.\r\nAlways throw DevRoundsError.\r\n')
})

after(() => removeDir(repo))

const rule = (key: string, evidence: Evidence[]) => ({ key, evidence })

test('an excerpt present with CRLF line endings verifies', async () => {
  const doc = { rules: [rule('a', [{ path: 'AGENTS.md', excerpt: 'sync fs.\nAlways throw', role: 'source' }])] }
  assert.deepEqual(await verifyEvidence(repo, doc), [])
})

test('a missing excerpt is an issue at /rules/0/evidence/1', async () => {
  const doc = {
    rules: [
      rule('a', [
        { path: 'AGENTS.md', excerpt: 'Never call sync fs.', role: 'source' },
        { path: 'AGENTS.md', excerpt: 'Never rerun a flaky test', role: 'source' },
      ]),
    ],
  }
  assert.deepEqual(await verifyEvidence(repo, doc), [
    { path: '/rules/0/evidence/1', reason: 'excerpt not found in AGENTS.md' },
  ])
})

test('a missing file is an issue', async () => {
  const doc = {
    rules: [],
    facts: [rule('layout', [{ path: 'docs/none.md', excerpt: 'x', role: 'example' }])],
  }
  assert.deepEqual(await verifyEvidence(repo, doc), [{ path: '/facts/0/evidence/0', reason: 'no such file' }])
})

test('an excerpt off its recorded line is moved, not an issue', async () => {
  const doc = { rules: [rule('a', [{ path: 'AGENTS.md', excerpt: 'Always throw', line: 2, role: 'source' }])] }
  const { issues, moved } = await inspectEvidence(repo, doc)
  assert.deepEqual(issues, [])
  assert.deepEqual(moved, [{ path: '/rules/0/evidence/0', key: 'a', file: 'AGENTS.md', line: 2, now: 4 }])
})

test('an excerpt found only inside a generated block is stale: render rewrites those lines', async () => {
  const dir = await mkdtemp(join(SCRATCH, 'evidence-block-'))
  try {
    const block = '<!-- devrounds:conventions begin version=1 sha256=0123456789abcdef -->\n- Never block.\n'
    await writeFile(join(dir, 'AGENTS.md'), `# Rules\n\n${block}<!-- devrounds:conventions end -->\n`)
    const doc = { rules: [rule('a', [{ path: 'AGENTS.md', excerpt: 'Never block.', role: 'source' }])] }
    assert.deepEqual(await verifyEvidence(dir, doc), [
      { path: '/rules/0/evidence/0', reason: 'excerpt not found in AGENTS.md' },
    ])
  } finally {
    await removeDir(dir)
  }
})
