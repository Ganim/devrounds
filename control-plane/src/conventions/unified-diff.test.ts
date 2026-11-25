import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { type DiffFile, parseUnifiedDiff } from './unified-diff.ts'

// A real diff (-U0) kept as a repo fixture: a rename with edits, a new file, a deleted file, "\ No newline", a binary
// file, quoted and tab-terminated paths with spaces, hunk lines that look like file headers and a mode-only change.
const FIXTURE = new URL('../../../roadmap/fixtures/conventions/parse.diff', import.meta.url)

async function parsed(eol = '\n'): Promise<Map<string, DiffFile>> {
  const text = (await readFile(FIXTURE, 'utf8')).replaceAll('\r\n', '\n').replaceAll('\n', eol)
  return new Map(parseUnifiedDiff(text).map((file) => [file.path, file]))
}

test('every file of the diff, in order, with its status', async () => {
  const files = await parsed()
  assert.deepEqual(
    [...files.values()].map((f) => [f.path, f.status, f.oldPath]),
    [
      ['docs/gone.md', 'deleted', null],
      ['src/crlf.ts', 'added', null],
      ['src/img.bin', 'added', null],
      ['src/mod.ts', 'modified', null],
      ['src/my dir/café file.ts', 'added', null],
      ['src/my dir/plain file.ts', 'added', null],
      ['src/new.ts', 'renamed', 'src/old.ts'],
      ['src/nonl.ts', 'modified', null],
      ['src/sql.ts', 'modified', null],
      ['bin/run.sh', 'modified', null],
    ],
  )
})

test('a rename with edits carries the new file line numbers', async () => {
  assert.deepEqual((await parsed()).get('src/new.ts')?.added, [
    { line: 3, text: 'THREE TODO' },
    { line: 8, text: 'eight TODO' },
  ])
})

test('a new file adds every line; a deleted file adds nothing', async () => {
  const files = await parsed()
  assert.deepEqual(files.get('src/crlf.ts')?.added, [
    { line: 1, text: 'first' },
    { line: 2, text: 'TODO crlf' },
  ])
  assert.deepEqual(files.get('docs/gone.md')?.added, [])
  assert.deepEqual(files.get('src/mod.ts')?.added, [{ line: 2, text: 'added TODO' }])
})

test('"\\ No newline at end of file" is not a line', async () => {
  assert.deepEqual((await parsed()).get('src/nonl.ts')?.added, [{ line: 2, text: 'b TODO' }])
})

test('a binary file is marked and has no lines', async () => {
  const bin = (await parsed()).get('src/img.bin')
  assert.equal(bin?.binary, true)
  assert.deepEqual(bin?.added, [])
  assert.equal((await parsed()).get('src/mod.ts')?.binary, false)
})

test('quoted paths are decoded and the tab after a path with spaces is dropped', async () => {
  const files = await parsed()
  assert.deepEqual(files.get('src/my dir/café file.ts')?.added, [{ line: 1, text: 'x TODO' }])
  assert.deepEqual(files.get('src/my dir/plain file.ts')?.added, [{ line: 1, text: 'y' }])
})

test('hunk lines that start with --- or +++ are content, not headers', async () => {
  assert.deepEqual((await parsed()).get('src/sql.ts')?.added, [{ line: 1, text: '++ added line' }])
})

test('CRLF lines parse as LF lines', async () => {
  assert.deepEqual(await parsed('\r\n'), await parsed())
})

test('a plain unified diff without the extended header', () => {
  const text = '--- a/x.ts\t2026-11-25\n+++ b/x.ts\t2026-11-25\n@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+more\n keep2\n'
  assert.deepEqual(parseUnifiedDiff(text), [
    {
      path: 'x.ts',
      oldPath: null,
      status: 'modified',
      binary: false,
      added: [
        { line: 2, text: 'new' },
        { line: 3, text: 'more' },
      ],
    },
  ])
})

test('an empty diff has no files', () => {
  assert.deepEqual(parseUnifiedDiff(''), [])
})
