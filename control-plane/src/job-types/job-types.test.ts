import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DevRoundsError } from '../errors/error.ts'
import type { Ctx } from '../planning/resolve.ts'
import { createProject } from '../planning/service.ts'
import { testDb } from '../test-support/db.ts'
import { parseJobTypeFile } from './file.ts'
import { getJobType, putJobType } from './service.ts'

const FILE = `key: check
command:
  program: pnpm
  args: [check]
env: [PATH]
timeout_s: 600
orphan_policy: let_finish
classify:
  - class: check_red
    exit_codes: [1]
  - class: environment
    log_pattern: ERR_PNPM_
retry:
  max_attempts: 3
  backoff_s: 10
  on: [infra, timeout]
`

test('a job type file round-trips through the project', async () => {
  const { db, newTenant } = await testDb()
  const tenant = await newTenant()
  const ctx: Ctx = { db, tenantId: tenant.tenantId, actor: { id: tenant.human.id, kind: 'human' } }
  await createProject(ctx, { key: 'devrounds', name: 'DevRounds' })
  const def = parseJobTypeFile(FILE)
  await putJobType(ctx, 'devrounds', def)
  assert.deepEqual(await getJobType(ctx, 'devrounds', 'check'), def)

  // Put again replaces the definition; omitted fields fall back to their defaults.
  const minimal = parseJobTypeFile('key: check\ncommand: { program: pnpm }\n')
  await putJobType(ctx, 'devrounds', minimal)
  assert.deepEqual(await getJobType(ctx, 'devrounds', 'check'), {
    key: 'check',
    command: { program: 'pnpm', args: [] },
    env: [],
    timeout_s: 3600,
    orphan_policy: 'kill',
    classify: [],
    retry: { max_attempts: 1, backoff_s: 30, on: ['infra'] },
  })
  await assert.rejects(
    putJobType(ctx, 'devrounds', { ...minimal, classify: [{ class: 'check_red', log_pattern: '[' }] }),
    (err: unknown) =>
      err instanceof DevRoundsError && err.code === 'DR101' && err.data.path === '/classify/0/log_pattern',
  )
  await assert.rejects(
    getJobType(ctx, 'devrounds', 'lint'),
    (err: unknown) => err instanceof DevRoundsError && err.code === 'DR201' && err.data.kind === 'job type',
  )
})

test('an unknown failure class is refused with DR101 at /classify/0/class', () => {
  const text = 'key: check\ncommand: { program: pnpm }\nclassify:\n  - class: flaky\n    exit_codes: [1]\n'
  assert.throws(
    () => parseJobTypeFile(text),
    (err: unknown) => err instanceof DevRoundsError && err.code === 'DR101' && err.data.path === '/classify/0/class',
  )
})

test('a rule without a condition or with a bad pattern is refused with DR101', () => {
  const rule = (body: string) => `key: check\ncommand: { program: pnpm }\nclassify:\n  - class: check_red\n${body}`
  for (const [body, path] of [
    ['', '/classify/0'],
    ['    log_pattern: "("\n', '/classify/0/log_pattern'],
  ]) {
    assert.throws(
      () => parseJobTypeFile(rule(body)),
      (err: unknown) => err instanceof DevRoundsError && err.code === 'DR101' && err.data.path === path,
    )
  }
})

test('retry.on cannot name cancelled (DR101 at /retry/on/0)', () => {
  const text = 'key: check\ncommand: { program: pnpm }\nretry:\n  on: [cancelled, infra]\n'
  assert.throws(
    () => parseJobTypeFile(text),
    (err: unknown) => err instanceof DevRoundsError && err.code === 'DR101' && err.data.path === '/retry/on/0',
  )
})
