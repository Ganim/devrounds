import assert from 'node:assert/strict'
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
