import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { bootstrap, initConfig } from './admin.ts'
import { resolveToken } from './auth/tokens.ts'
import { loadConfig, loadServerConfig } from './config.ts'
import { DevRoundsError } from './errors/error.ts'
import { TEST_APP_ROLE, testDb } from './test-support/db.ts'

test('init writes a loadable config and refuses to overwrite it without force', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'devrounds-init-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'nested', 'server.json')

  const written = await initConfig(path, { force: false })
  const config = await loadConfig({}, path)
  assert.deepEqual(config, written)
  assert.equal(config.port, 4992)
  assert.equal(config.adminDatabaseUrl, 'postgres://postgres:postgres@127.0.0.1:15433/devrounds')
  assert.equal(config.databaseUrl, `postgres://devrounds_app:${config.appPassword}@127.0.0.1:15433/devrounds`)

  await assert.rejects(
    initConfig(path, { force: false }),
    (err) => err instanceof DevRoundsError && err.code === 'DR101',
  )
  assert.equal(await readFile(path, 'utf8'), `${JSON.stringify(written, null, 2)}\n`)

  const replaced = await initConfig(path, { force: true })
  assert.notEqual(replaced.appPassword, written.appPassword)
})

test('serve config loads without an admin URL and never returns owner credentials', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'devrounds-serve-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'server.json')
  await writeFile(path, JSON.stringify({ databaseUrl: 'postgres://app@127.0.0.1/devrounds', port: 4992 }))
  assert.deepEqual(await loadServerConfig({}, path), { databaseUrl: 'postgres://app@127.0.0.1/devrounds', port: 4992 })
  await assert.rejects(loadConfig({}, path), (err) => err instanceof DevRoundsError && err.code === 'DR502')

  const full = join(dir, 'full.json')
  await initConfig(full, { force: false })
  assert.deepEqual(Object.keys(await loadServerConfig({}, full)).sort(), ['databaseUrl', 'port'])
})

// The owner connection skips RLS; bootstrap must still see only its own tenant when the service checks for the key.
test('bootstrap gives each tenant its own project, even with the same key', async () => {
  const { admin, db } = await testDb()
  const run = () =>
    bootstrap(admin, TEST_APP_ROLE, { tenant: `t-${randomUUID()}`, project: 'demo', name: 'Demo', human: 'gui' })
  const first = await resolveToken(db, (await run()).token)
  const second = await resolveToken(db, (await run()).token)
  assert.notEqual(first.tenantId, second.tenantId)
  assert.equal(first.member.kind, 'human')
})
