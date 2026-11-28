import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createToken } from '../auth/tokens.ts'
import { createProject } from '../planning/service.ts'
import { type TestDb, type TestTenant, testDb } from '../test-support/db.ts'
import { buildServer } from './server.ts'

let t: TestDb
let app: ReturnType<typeof buildServer>

before(async () => {
  t = await testDb()
  app = buildServer({ db: t.db, logger: false })
  await app.ready()
})

after(() => app.close())

// A tenant with project `alpha` and a token per device of its human member, plus one for its agent member.
async function setup(): Promise<{ tenant: TestTenant; laptop: string; phone: string; agent: string }> {
  const tenant = await t.newTenant()
  await createProject({ db: t.db, tenantId: tenant.tenantId, actor: tenant.human }, { key: 'alpha', name: 'Alpha' })
  // Two tokens of one member stand for two devices: prefs belong to the member, not to the token or the browser.
  const bearer = async (kind: 'human' | 'agent') => `Bearer ${await createToken(t.admin, tenant.tenantId, kind, kind)}`
  return { tenant, laptop: await bearer('human'), phone: await bearer('human'), agent: await bearer('agent') }
}

const put = (authorization: string, name: string, value: unknown, project = 'alpha') =>
  app.inject({
    method: 'PUT',
    url: `/api/projects/${project}/prefs/${name}`,
    headers: { authorization },
    payload: { value },
  })

const get = (authorization: string, path: string) =>
  app.inject({ method: 'GET', url: `/api/projects/alpha${path}`, headers: { authorization } })

test('order and names saved on one device show on another of the same member', async () => {
  const { laptop, phone } = await setup()
  const order = { ids: ['b', 'a', 'c'] }
  const names = { a: 'Billing', b: 'Docs' }
  assert.equal((await put(laptop, 'sessions.order', order)).statusCode, 200)
  assert.equal((await put(laptop, 'sessions.names', names)).statusCode, 200)
  // A second save replaces the value.
  const saved = await put(laptop, 'sessions.order', { ids: ['c', 'b', 'a'] })
  assert.equal(saved.statusCode, 200, saved.body)
  assert.deepEqual(saved.json().value, { ids: ['c', 'b', 'a'] })

  const one = await get(phone, '/prefs/sessions.names')
  assert.equal(one.statusCode, 200, one.body)
  assert.deepEqual(one.json().value, names)
  const all = await get(phone, '/prefs')
  assert.deepEqual(
    all.json().prefs.map((p: { name: string; value: unknown }) => [p.name, p.value]),
    [
      ['sessions.names', names],
      ['sessions.order', { ids: ['c', 'b', 'a'] }],
    ],
  )
})

test('an unset pref reads as null, and another member of the tenant never sees one', async () => {
  const { laptop, agent } = await setup()
  await put(laptop, 'board.columns', ['todo', 'done'])
  const other = await get(agent, '/prefs/board.columns')
  assert.equal(other.statusCode, 200, other.body)
  assert.deepEqual(other.json(), { name: 'board.columns', value: null, updatedAt: null })
  assert.deepEqual((await get(agent, '/prefs')).json(), { prefs: [] })
})

test("prefs stay in their tenant: another tenant's project is DR201 and its rows are invisible", async () => {
  const a = await setup()
  const b = await setup()
  await put(a.laptop, 'sessions.order', { ids: ['x'] })
  // Both tenants have a project `alpha`; each reads only its own row.
  assert.deepEqual((await get(b.laptop, '/prefs')).json(), { prefs: [] })
  const missing = await put(a.laptop, 'sessions.order', {}, 'beta')
  assert.equal(missing.statusCode, 404)
  assert.equal(missing.json().code, 'DR201')
})

test('a bad name, a missing value or a value over 64 KiB answers DR101', async () => {
  const { laptop } = await setup()
  const bad = await put(laptop, 'Sessions Order', 1)
  assert.equal(bad.json().code, 'DR101')
  const missing = await app.inject({
    method: 'PUT',
    url: '/api/projects/alpha/prefs/sessions.order',
    headers: { authorization: laptop },
    payload: {},
  })
  assert.equal(missing.json().code, 'DR101')
  const big = await put(laptop, 'sessions.order', 'x'.repeat(64 * 1024))
  assert.equal(big.json().code, 'DR101')
  assert.deepEqual(big.json().data, { path: '/value', reason: 'is over 65536 bytes of JSON' })
})
