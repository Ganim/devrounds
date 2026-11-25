import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DevRoundsError } from '../errors/error.ts'
import { documentSha, findConventionsIssue, parseConventionsFile } from './file.ts'

const FILE = `targets:
  - path: AGENTS.md
  - path: README.md
rules:
  - key: engine.no-tool-names
    section: Never
    title: Never put a vendor, customer or tool name in engine code
    why: Providers are adapters; a name in the core forks it for the second customer.
    paths: [control-plane/src/**/*.ts]
    exclude: ["**/*.test.ts"]
    check: { kind: pattern, forbid: '\\b(clickmax|devlanes)\\b', unless: 'allowed-name', flags: i }
    examples: { bad: ["// devlanes default"], good: ["// default need", "// Clickmax allowed-name"] }
    evidence:
      - { path: AGENTS.md, excerpt: "Never put a vendor, customer or tool name in engine code", role: source }
facts:
  - key: layout.control-plane
    section: Layout
    text: "control-plane/: the TypeScript control plane."
    target: README.md
    evidence: [{ path: control-plane/package.json, excerpt: '"fastify"', role: example }]
`

const refusedAt = (text: string, path: string) =>
  assert.throws(
    () => parseConventionsFile(text),
    (err: unknown) => err instanceof DevRoundsError && err.code === 'DR101' && err.data.path === path,
  )

test('a bad example that does not match forbid is DR101 at /rules/0/examples/bad/0', () => {
  refusedAt(FILE.replace('bad: ["// devlanes default"]', 'bad: ["// plain"]'), '/rules/0/examples/bad/0')
})

test('a good example that matches is DR101 at /rules/0/examples/good/1', () => {
  refusedAt(FILE.replace('"// Clickmax allowed-name"', '"// Clickmax"'), '/rules/0/examples/good/1')
})

test('flags g is refused', () => {
  refusedAt(FILE.replace('flags: i', 'flags: gi'), '/rules/0/check/flags')
})

test('a pattern rule without paths is refused', () => {
  refusedAt(FILE.replace('    paths: [control-plane/src/**/*.ts]\n', ''), '/rules/0/paths')
})

test('a duplicate key across a rule and a fact is refused', () => {
  refusedAt(FILE.replace('key: layout.control-plane', 'key: engine.no-tool-names'), '/facts/0/key')
})

test('a target outside targets is refused', () => {
  refusedAt(FILE.replace('target: README.md', 'target: docs/README.md'), '/facts/0/target')
})

test('a multi-line example is refused: the checker matches one added line at a time', () => {
  refusedAt(FILE.replace('bad: ["// devlanes default"]', 'bad: ["// devlanes\\ndefault"]'), '/rules/0/examples/bad/0')
})

test('an alias that contains itself is DR101 at /, not a crash', () => {
  refusedAt('targets: &a [*a]\nrules: []\n', '/')
})

test('a brace range glob is refused: the matcher expands it', () => {
  refusedAt(FILE.replace('control-plane/src/**/*.ts', '"src/{1..2000000}.ts"'), '/rules/0/paths/0')
})

test('defaults fill severity warn and the first target', () => {
  const def = parseConventionsFile(FILE)
  assert.equal(def.rules[0].severity, 'warn')
  assert.equal(def.rules[0].target, 'AGENTS.md')
  assert.equal(def.facts[0].target, 'README.md')
  const minimal = parseConventionsFile(
    [
      'targets: [{ path: AGENTS.md }]',
      'rules:',
      '  - { key: review.small, section: Always, title: Keep changes small, why: Reviews stay short., check: { kind: judgment }, evidence: [{ path: AGENTS.md, excerpt: small, role: source }] }',
    ].join('\n'),
  )
  assert.deepEqual(minimal.rules[0], {
    key: 'review.small',
    section: 'Always',
    title: 'Keep changes small',
    why: 'Reviews stay short.',
    check: { kind: 'judgment' },
    evidence: [{ path: 'AGENTS.md', excerpt: 'small', role: 'source' }],
    severity: 'warn',
    target: 'AGENTS.md',
    paths: [],
    exclude: [],
  })
  assert.deepEqual(minimal.facts, [])
})

test('documentSha ignores key order', () => {
  const def = parseConventionsFile(FILE)
  const reordered = JSON.parse(JSON.stringify({ facts: def.facts, rules: def.rules, targets: def.targets }))
  reordered.rules[0] = Object.fromEntries(Object.entries(reordered.rules[0]).reverse())
  assert.match(documentSha(def), /^[0-9a-f]{64}$/)
  assert.equal(documentSha(reordered), documentSha(def))
  assert.notEqual(documentSha({ ...def, targets: [{ path: 'README.md' }] }), documentSha(def))
  assert.equal(findConventionsIssue(def), null)
})
