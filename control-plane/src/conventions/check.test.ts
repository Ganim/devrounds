import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkChange } from './check.ts'
import { type RuleFile, withDefaults } from './file.ts'
import type { DiffFile } from './unified-diff.ts'

const evidence = [{ path: 'AGENTS.md', excerpt: 'Never', role: 'source' as const }]

function rule(key: string, fields: Partial<RuleFile>): RuleFile {
  return {
    key,
    section: 'Never',
    title: `title of ${key}`,
    why: 'why',
    check: { kind: 'judgment' },
    evidence,
    ...fields,
  }
}

const defOf = (...rules: RuleFile[]) => withDefaults({ targets: [{ path: 'AGENTS.md' }], rules })

function file(path: string, added: string[], fields: Partial<DiffFile> = {}): DiffFile {
  return {
    path,
    oldPath: null,
    status: 'modified',
    binary: false,
    added: added.map((text, i) => ({ line: i + 1, text })),
    ...fields,
  }
}

const noSync = rule('engine.no-sync', {
  paths: ['src/**/*.ts'],
  exclude: ['**/*.test.ts'],
  check: { kind: 'pattern', forbid: 'Sync\\(', unless: 'allow-sync' },
  severity: 'block',
  examples: { bad: ['readFileSync('] },
})

test('a pattern rule fires on an added line of a covered file, with its line and excerpt', () => {
  assert.deepEqual(checkChange(defOf(noSync), [file('src/a.ts', ['ok', '  const x = readFileSync(p)  '])]), [
    { rule: 'engine.no-sync', severity: 'block', path: 'src/a.ts', line: 2, excerpt: 'const x = readFileSync(p)' },
  ])
})

test('unless on the same line silences the pattern', () => {
  assert.deepEqual(checkChange(defOf(noSync), [file('src/a.ts', ['readFileSync(p) // allow-sync'])]), [])
})

test('exclude wins over paths', () => {
  assert.deepEqual(checkChange(defOf(noSync), [file('src/a.test.ts', ['readFileSync(p)'])]), [])
})

test('a match on a removed line only is no violation', () => {
  // A parsed diff keeps only added lines: the file that only lost `readFileSync(` has none.
  assert.deepEqual(checkChange(defOf(noSync), [file('src/a.ts', [])]), [])
})

test('deleted and binary files are not read; files outside paths are not either', () => {
  const files = [
    file('src/gone.ts', ['readFileSync('], { status: 'deleted' }),
    file('src/img.ts', ['readFileSync('], { binary: true }),
    file('docs/a.md', ['readFileSync(']),
  ]
  assert.deepEqual(checkChange(defOf(noSync), files), [])
})

test('the excerpt is cut to 200 characters', () => {
  const [v] = checkChange(defOf(noSync), [file('src/a.ts', [`readFileSync(${'x'.repeat(300)}`])])
  assert.equal(v.excerpt.length, 200)
})

const testsInTestDir = rule('tests.in-test-dir', {
  exclude: ['test/**'],
  check: { kind: 'path', forbid_new: '**/*.test.ts' },
  severity: 'block',
})

test('a path rule refuses a new test file outside test/ and not a modified one', () => {
  const files = [
    file('src/a.test.ts', [], { status: 'added' }),
    file('test/b.test.ts', [], { status: 'added' }),
    file('src/c.test.ts', ['x'], { status: 'modified' }),
    file('src/d.ts', [], { status: 'added' }),
  ]
  assert.deepEqual(checkChange(defOf(testsInTestDir), files), [
    { rule: 'tests.in-test-dir', severity: 'block', path: 'src/a.test.ts', line: null, excerpt: 'src/a.test.ts' },
  ])
})

test('a path rule refuses a rename into the glob, not one inside it', () => {
  const files = [
    file('src/a.test.ts', [], { status: 'renamed', oldPath: 'test/a.test.ts' }),
    file('src/b.test.ts', [], { status: 'renamed', oldPath: 'src/b.spec.test.ts' }),
  ]
  assert.deepEqual(
    checkChange(defOf(testsInTestDir), files).map((v) => v.path),
    ['src/a.test.ts'],
  )
})

test('warn violations do not count as blocking', () => {
  const warn = { ...noSync, key: 'engine.warn', severity: 'warn' as const }
  const violations = checkChange(defOf(warn), [file('src/a.ts', ['readFileSync('])])
  assert.deepEqual(
    violations.map((v) => v.severity),
    ['warn'],
  )
})

test('job_type and judgment rules are not evaluated', () => {
  const def = defOf(
    rule('repo.judgment', { severity: 'block' }),
    rule('repo.lint', { check: { kind: 'job_type', enforced_by: 'lint' }, severity: 'block' }),
  )
  assert.deepEqual(checkChange(def, [file('src/a.ts', ['anything'], { status: 'added' })]), [])
})
