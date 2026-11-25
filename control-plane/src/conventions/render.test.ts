import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type ConventionsFile, withDefaults } from './file.ts'
import { applyBlock, driftOf, readBlock, renderBlocks } from './render.ts'

const evidence = [{ path: 'AGENTS.md', excerpt: 'Never', role: 'source' as const }]

const def = withDefaults({
  targets: [{ path: 'AGENTS.md' }, { path: 'README.md' }],
  rules: [
    {
      key: 'engine.no-sync',
      section: 'Never',
      title: 'Never call *Sync fs functions',
      why: 'They block the event loop.',
      paths: ['control-plane/src/**/*.ts'],
      check: { kind: 'pattern', forbid: 'Sync\\(' },
      severity: 'block',
      examples: { bad: ['readFileSync('] },
      evidence,
    },
    {
      key: 'errors.throw',
      section: 'Always',
      title: 'Throw DevRoundsError',
      why: 'Codes map to exit codes.',
      check: { kind: 'job_type', enforced_by: 'devrounds-test' },
      evidence,
    },
    {
      key: 'engine.adapters',
      section: 'Never',
      title: 'Never put a vendor name in engine code',
      why: 'Providers are adapters.',
      check: { kind: 'judgment' },
      evidence,
    },
  ],
  facts: [
    {
      key: 'layout.cp',
      section: 'Layout',
      text: 'control-plane/: the TypeScript control plane.',
      target: 'README.md',
      evidence,
    },
  ],
} satisfies ConventionsFile)

const HAND = '# AGENTS.md\n\nHand-written header.\n'

test('render groups rules by section in first-seen order', () => {
  const blocks = renderBlocks(def, 2)
  assert.deepEqual([...blocks.keys()], ['AGENTS.md', 'README.md'])
  const agents = blocks.get('AGENTS.md') ?? ''
  const lines = agents.split('\n')
  assert.match(lines[0], /^<!-- devrounds:conventions begin version=2 sha256=[0-9a-f]{16} -->$/)
  assert.deepEqual(lines.slice(1), [
    '### Never',
    '',
    '- Never call *Sync fs functions. They block the event loop. (checked)',
    '- Never put a vendor name in engine code. Providers are adapters.',
    '',
    '### Always',
    '',
    '- Throw DevRoundsError. Codes map to exit codes. (checked by devrounds-test)',
    '<!-- devrounds:conventions end -->',
  ])
  assert.match(blocks.get('README.md') ?? '', /### Layout\n\n- control-plane\/: the TypeScript control plane\.\n/)
})

test('an untouched render read back with CRLF has no drift', () => {
  const agents = applyBlock(HAND.replaceAll('\n', '\r\n'), renderBlocks(def, 2).get('AGENTS.md') ?? '')
  assert.ok(!agents.replaceAll('\r\n', '').includes('\n'), 'written with the file ending')
  const readme = applyBlock('', renderBlocks(def, 2).get('README.md') ?? '').replaceAll('\n', '\r\n')
  assert.deepEqual(
    driftOf(
      def,
      2,
      new Map([
        ['AGENTS.md', agents],
        ['README.md', readme],
      ]),
    ),
    [],
  )
})

test('a hand edit inside the block is different', () => {
  const agents = applyBlock(HAND, renderBlocks(def, 2).get('AGENTS.md') ?? '').replace('(checked)', '(optional)')
  const readme = applyBlock('', renderBlocks(def, 2).get('README.md') ?? '')
  const files = new Map([
    ['AGENTS.md', agents],
    ['README.md', readme],
  ])
  assert.deepEqual(driftOf(def, 2, files), [{ path: 'AGENTS.md', reason: 'different' }])
})

test('a block of version 3 while 2 is active is different', () => {
  const files = new Map<string, string | null>([
    ['AGENTS.md', applyBlock(HAND, renderBlocks(def, 3).get('AGENTS.md') ?? '')],
    ['README.md', applyBlock('', renderBlocks(def, 2).get('README.md') ?? '')],
  ])
  assert.deepEqual(driftOf(def, 2, files), [{ path: 'AGENTS.md', reason: 'different' }])
})

test('a target without a block is missing_block', () => {
  const files = new Map<string, string | null>([
    ['AGENTS.md', HAND],
    ['README.md', null],
  ])
  assert.deepEqual(driftOf(def, 2, files), [
    { path: 'AGENTS.md', reason: 'missing_block' },
    { path: 'README.md', reason: 'missing_file' },
  ])
  const halfBlock = `${HAND}<!-- devrounds:conventions begin version=2 sha256=0123456789abcdef -->\n### Never\n`
  assert.equal(readBlock(halfBlock), 'malformed')
  assert.equal(readBlock(HAND), null)
})

test('applyBlock keeps the text outside the block byte-identical', () => {
  const before = '# AGENTS.md\r\n\r\nHeader.\r\n\r\n'
  const after = '\r\n## Accepted\r\n\r\n- trailing text  \r\n'
  const old = renderBlocks(def, 1).get('AGENTS.md') ?? ''
  const next = renderBlocks(def, 2).get('AGENTS.md') ?? ''
  const text = `${before}${old.replaceAll('\n', '\r\n')}${after}`
  const replaced = applyBlock(text, next)
  assert.equal(replaced, `${before}${next.replaceAll('\n', '\r\n')}${after}`)
  assert.deepEqual(readBlock(replaced), {
    version: 2,
    sha: next.match(/sha256=([0-9a-f]{16})/)?.[1],
    body: next.split('\n').slice(1, -1).join('\n'),
  })
})
