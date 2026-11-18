import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Type } from '@sinclair/typebox'
import { toDevRoundsError } from '../convert-error.ts'
import { rustFiles } from '../test-support/rust-files.ts'
import { validate } from '../validate.ts'
import { exitCodeFor } from './codes.ts'
import { renderErrorDocs } from './docs.ts'
import { DevRoundsError, explain, fail, MISSING } from './error.ts'
import { WORDS } from './words.ts'

const SRC = fileURLToPath(new URL('..', import.meta.url))
const DOCS = fileURLToPath(new URL('../../../docs/errors.md', import.meta.url))
const EMIT = /(fail|new DevRoundsError)\(\s*['"](DR\d{3})['"]/g
const RUST_EMIT = /DrError::new\(\s*"(DR\d{3})"/g

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return entry.name === 'errors' ? [] : sourceFiles(path)
      return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : []
    }),
  )
  return nested.flat()
}

async function emittedCodes(): Promise<Set<string>> {
  const codes = new Set<string>()
  for (const file of await sourceFiles(SRC)) {
    for (const match of (await readFile(file, 'utf8')).matchAll(EMIT)) codes.add(match[2])
  }
  // The executor shares the code table: its Rust errors need words too.
  for (const file of await rustFiles()) {
    for (const match of (await readFile(file, 'utf8')).matchAll(RUST_EMIT)) codes.add(match[1])
  }
  return codes
}

test('every code emitted in source has words', async () => {
  const missing = [...(await emittedCodes())].filter((code) => !(code in WORDS))
  assert.deepEqual(missing, [], 'add these codes to control-plane/src/errors/words.ts')
})

test('every code in words is emitted somewhere', async () => {
  const emitted = await emittedCodes()
  const unused = Object.keys(WORDS).filter((code) => !emitted.has(code))
  assert.deepEqual(unused, [])
})

test('exit code follows the range table', () => {
  assert.equal(exitCodeFor('DR101'), 2)
  assert.equal(exitCodeFor('DR201'), 3)
  assert.equal(exitCodeFor('DR301'), 1)
  assert.equal(exitCodeFor('DR401'), 5)
  assert.equal(exitCodeFor('DR501'), 6)
  assert.equal(exitCodeFor('DR999'), 6)
  assert.equal(exitCodeFor('garbage'), 6)
  assert.equal(exitCodeFor(''), 6)
})

test('explain fills placeholders and maps statuses', () => {
  const invalid = explain('DR101', { path: '/name', reason: 'required' })
  assert.match(invalid.text, /\/name/)
  assert.equal(invalid.httpStatus, 400)
  assert.equal(invalid.exitCode, 2)
  assert.equal(explain('DR501').httpStatus, 500)
})

test('fail throws a DevRoundsError carrying code and data', () => {
  assert.throws(
    () => fail('DR101', { path: '/x', reason: 'bad' }),
    (err) => err instanceof DevRoundsError && err.code === 'DR101' && err.data.path === '/x',
  )
})

test('validate returns the value or fails with DR101 and the path', () => {
  const schema = Type.Object({ name: Type.String() })
  assert.deepEqual(validate(schema, { name: 'a' }), { name: 'a' })
  assert.throws(
    () => validate(schema, { name: 1 }),
    (err) => err instanceof DevRoundsError && err.code === 'DR101' && err.data.path === '/name',
  )
})

test('toDevRoundsError keeps DevRoundsError and wraps anything else as DR501', () => {
  const own = new DevRoundsError('DR101', { path: '/', reason: 'x' })
  assert.equal(toDevRoundsError(own), own)
  assert.equal(toDevRoundsError(new Error('boom')).code, 'DR501')
  assert.equal(toDevRoundsError('str').code, 'DR501')
})

test('docs/errors.md is current', async () => {
  const onDisk = (await readFile(DOCS, 'utf8')).replace(/\r\n/g, '\n')
  assert.equal(onDisk, renderErrorDocs(), 'run pnpm gen:errors')
})

test('every placeholder in text and hint is declared in keys', () => {
  for (const [code, words] of Object.entries(WORDS)) {
    const used = new Set([...`${words.text} ${words.hint}`.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))
    assert.deepEqual([...used].sort(), [...words.keys].sort(), `${code}: keys must match placeholders`)
  }
})

test('a missing data key renders the neutral marker, never a raw placeholder', () => {
  const { text, hint } = explain('DR101', { path: '/a' })
  assert.equal(text, `Invalid input at /a: ${MISSING}.`)
  assert.ok(!text.includes('{') && !hint.includes('{'))
})
