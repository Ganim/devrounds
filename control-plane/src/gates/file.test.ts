import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { DevRoundsError } from '../errors/error.ts'
import { normalizeCwd, parseGateFile } from './file.ts'

test('normalizeCwd maps C:\\Src\\app\\, c:/Src/app and c:\\Src\\app to one key and keeps c:\\ as is', () => {
  assert.deepEqual(['C:\\Src\\app\\', 'c:/Src/app', 'c:\\Src\\app', 'C:/Src/app//'].map(normalizeCwd), [
    'c:\\Src\\app',
    'c:\\Src\\app',
    'c:\\Src\\app',
    'c:\\Src\\app',
  ])
  assert.deepEqual(['c:\\', 'C:/', 'c:\\\\'].map(normalizeCwd), ['c:\\', 'c:\\', 'c:\\'])
})

test('a gate file with an unknown field answers DR101 at its path', () => {
  const text = ['key: pre-pr', 'checks:', '  - ref: lint', '    job_type: lint', '    cwd: C:\\src\\app'].join('\n')
  assert.throws(
    () => parseGateFile(text),
    (err: unknown) =>
      err instanceof DevRoundsError && err.code === 'DR101' && err.data.path === '/checks/0/cwd' && err.data.line === 5,
  )
  assert.deepEqual(parseGateFile(text.split('\n').slice(0, 4).join('\n')), {
    key: 'pre-pr',
    checks: [{ ref: 'lint', job_type: 'lint' }],
  })
})

test('every gate fixture parses and names job types that exist in roadmap/fixtures/job-types', async () => {
  const root = new URL('../../../roadmap/fixtures/', import.meta.url)
  const jobTypes = new Set((await readdir(new URL('job-types/', root))).map((name) => name.replace(/\.yaml$/, '')))
  const gates = await readdir(new URL('gates/', root))
  assert.ok(gates.length > 0)
  for (const name of gates) {
    const gate = parseGateFile(await readFile(new URL(`gates/${name}`, root), 'utf8'))
    for (const check of gate.checks)
      assert.ok(jobTypes.has(check.job_type), `${name}: ${check.ref} -> ${check.job_type}`)
  }
})
