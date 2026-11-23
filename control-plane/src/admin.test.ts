import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { bootstrap, initConfig, migrate, projectAdd } from './admin.ts'
import { resolveToken } from './auth/tokens.ts'
import { defaultLogsRoot, loadConfig, loadServerConfig } from './config.ts'
import { DevRoundsError } from './errors/error.ts'
import { withTenant } from './tenancy/scope.ts'
import { TEST_ADMIN_URL, TEST_APP_PASSWORD, TEST_APP_ROLE, testDb } from './test-support/db.ts'

test('init writes a loadable config and refuses to overwrite it without force', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'devrounds-init-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'nested', 'server.json')

  const written = await initConfig(path, { force: false })
  const config = await loadConfig({}, path)
  // The scheduler settings are not written; their defaults come back.
  assert.deepEqual(config, { ...written, schedulerPollS: 15, offerTimeoutS: 120 })
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
  assert.deepEqual(await loadServerConfig({}, path), {
    databaseUrl: 'postgres://app@127.0.0.1/devrounds',
    port: 4992,
    logsRoot: defaultLogsRoot(),
    logRetentionDays: 14,
    schedulerPollS: 15,
    offerTimeoutS: 120,
  })
  const bad = (env: Record<string, string>) =>
    assert.rejects(loadServerConfig(env, path), (err) => err instanceof DevRoundsError && err.code === 'DR502')
  for (const value of ['0', '-1', 'soon']) await bad({ DEVROUNDS_SCHEDULER_POLL_S: value })
  for (const value of ['4', '7.5', 'never']) await bad({ DEVROUNDS_OFFER_TIMEOUT_S: value })
  const tuned = await loadServerConfig({ DEVROUNDS_SCHEDULER_POLL_S: '0.5', DEVROUNDS_OFFER_TIMEOUT_S: '5' }, path)
  assert.deepEqual([tuned.schedulerPollS, tuned.offerTimeoutS], [0.5, 5])
  await assert.rejects(loadConfig({}, path), (err) => err instanceof DevRoundsError && err.code === 'DR502')

  const full = join(dir, 'full.json')
  await initConfig(full, { force: false })
  assert.deepEqual(Object.keys(await loadServerConfig({}, full)).sort(), [
    'databaseUrl',
    'logRetentionDays',
    'logsRoot',
    'offerTimeoutS',
    'port',
    'schedulerPollS',
  ])
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

test('project add creates a second project in the tenant with a create_project event by import', async () => {
  const { admin, db } = await testDb()
  const tenant = `t-${randomUUID()}`
  await bootstrap(admin, TEST_APP_ROLE, { tenant, project: 'alpha', name: 'Alpha', human: 'gui' })
  const added = await projectAdd(admin, TEST_APP_ROLE, { tenant, key: 'beta', name: 'Beta' })

  const found = await admin.selectFrom('tenants').select('id').where('name', '=', tenant).executeTakeFirstOrThrow()
  const rows = await withTenant(db, found.id, async (trx) => ({
    projects: await trx.selectFrom('projects').select('key').orderBy('key').execute(),
    event: await trx
      .selectFrom('plan_events')
      .innerJoin('members', 'members.id', 'plan_events.actor_id')
      .select(['plan_events.kind', 'plan_events.project_id', 'members.name as actor'])
      .where('plan_events.id', '=', added.eventId)
      .executeTakeFirstOrThrow(),
  }))
  assert.deepEqual(rows.projects, [{ key: 'alpha' }, { key: 'beta' }])
  assert.deepEqual(rows.event, { kind: 'create_project', project_id: added.projectId, actor: 'import' })
})

test('project add with a taken key answers DR101 at /key', async () => {
  const { admin } = await testDb()
  const tenant = `t-${randomUUID()}`
  await bootstrap(admin, TEST_APP_ROLE, { tenant, project: 'alpha', name: 'Alpha', human: 'gui' })
  await assert.rejects(
    projectAdd(admin, TEST_APP_ROLE, { tenant, key: 'alpha', name: 'Again' }),
    (err) => err instanceof DevRoundsError && err.code === 'DR101' && err.data.path === '/key',
  )
})

test('project add for an unknown tenant answers DR201 kind tenant', async () => {
  const { admin } = await testDb()
  await assert.rejects(
    projectAdd(admin, TEST_APP_ROLE, { tenant: `t-${randomUUID()}`, key: 'beta', name: 'Beta' }),
    (err) => err instanceof DevRoundsError && err.code === 'DR201' && err.data.kind === 'tenant',
  )
})

// The secret signs session cookies: a second migrate must keep it, or every browser would be signed out.
test('migrate writes authSecret once and keeps it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'devrounds-migrate-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'server.json')
  // The test role's own password, so this migrate leaves the role as every other test file expects it.
  const file = {
    databaseUrl: 'postgres://app@127.0.0.1/devrounds',
    adminDatabaseUrl: TEST_ADMIN_URL,
    appPassword: TEST_APP_PASSWORD,
  }
  await writeFile(path, JSON.stringify(file))

  await migrate(path, TEST_APP_ROLE, {})
  const first = JSON.parse(await readFile(path, 'utf8'))
  assert.match(first.authSecret, /^[A-Za-z0-9_-]{43}$/)
  assert.deepEqual(first, { ...file, authSecret: first.authSecret })
  assert.equal((await loadServerConfig({}, path)).authSecret, first.authSecret)

  await migrate(path, TEST_APP_ROLE, {})
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), first)
})
