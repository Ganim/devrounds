import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createToken, revokeToken } from '../auth/tokens.ts'
import { explain } from '../errors/error.ts'
import { addPhase, createProject } from '../planning/service.ts'
import type { PlanView } from '../planning/view.ts'
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

// A tenant with project `alpha` (one phase P0) and a token for its human member.
async function setup(): Promise<{ tenant: TestTenant; auth: { authorization: string } }> {
  const tenant = await t.newTenant()
  const ctx = { db: t.db, tenantId: tenant.tenantId, actor: tenant.human }
  await createProject(ctx, { key: 'alpha', name: 'Alpha' })
  await addPhase(ctx, { projectKey: 'alpha', key: 'P0', title: 'Foundation', goal: 'Ship it' })
  const token = await createToken(t.admin, tenant.tenantId, 'human', 'human')
  return { tenant, auth: { authorization: `Bearer ${token}` } }
}

test('health answers without a token', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/health' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().ok, true)
  assert.equal(typeof res.json().version, 'string')
})

test('no token, an unknown token and a revoked token all get 401 DR401', async () => {
  const { tenant } = await setup()
  const missing = await app.inject({ method: 'GET', url: '/api/projects/alpha/plan' })
  assert.equal(missing.statusCode, 401)
  assert.deepEqual(missing.json(), { code: 'DR401', ...words('DR401'), data: {} })

  const unknown = await app.inject({
    method: 'GET',
    url: '/api/projects/alpha/plan',
    headers: { authorization: `Bearer drt_${'A'.repeat(43)}` },
  })
  assert.equal(unknown.json().code, 'DR401')

  const token = await createToken(t.admin, tenant.tenantId, 'robot', 'agent')
  const row = await t.admin
    .selectFrom('api_tokens')
    .select('id')
    .where('tenant_id', '=', tenant.tenantId)
    .orderBy('created_at', 'desc')
    .executeTakeFirstOrThrow()
  await revokeToken(t.admin, row.id)
  const revoked = await app.inject({
    method: 'GET',
    url: '/api/projects/alpha/plan',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(revoked.statusCode, 401)
})

test('project key existing only in another tenant answers 404 DR201', async () => {
  const { auth } = await setup()
  const other = await t.newTenant()
  await createProject({ db: t.db, tenantId: other.tenantId, actor: other.human }, { key: 'beta', name: 'Beta' })

  const res = await app.inject({ method: 'GET', url: '/api/projects/beta/plan', headers: auth })
  assert.equal(res.statusCode, 404)
  assert.equal(res.json().code, 'DR201')
  assert.deepEqual(res.json().data, { kind: 'project', key: 'beta' })
})

test('domain error carries code, text and hint', async () => {
  const { auth } = await setup()
  const res = await app.inject({
    method: 'POST',
    url: '/api/projects/alpha/phases/P0/reopen',
    headers: auth,
    payload: { reason: 'try' },
  })
  assert.equal(res.statusCode, 409)
  const data = { phase: 'P0', state: 'open' }
  assert.deepEqual(res.json(), { code: 'DR306', ...words('DR306', data), data })
})

test('schema violations come out as DR101 with the path', async () => {
  const { auth } = await setup()
  const res = await app.inject({
    method: 'POST',
    url: '/api/projects/alpha/tasks',
    headers: auth,
    payload: { key: 'P0-T01' },
  })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().code, 'DR101')
  assert.equal(res.json().data.path, '/title')
})

test('plan returns PlanView with the task added through the API', async () => {
  const { auth } = await setup()
  const added = await app.inject({
    method: 'POST',
    url: '/api/projects/alpha/tasks',
    headers: auth,
    payload: { key: 'P0-T01', title: 'Schema', phaseKey: 'P0', criteria: ['RLS on'] },
  })
  assert.equal(added.statusCode, 200)
  assert.match(added.json().eventId, /^\d+$/)

  const res = await app.inject({ method: 'GET', url: '/api/projects/alpha/plan', headers: auth })
  assert.equal(res.statusCode, 200)
  const plan = res.json() as PlanView
  assert.deepEqual(plan.project, { key: 'alpha', name: 'Alpha' })
  assert.deepEqual(
    plan.phases.map((p) => [p.key, p.tasks.map((task) => [task.key, task.state, task.criteria.length])]),
    [['P0', [['P0-T01', 'todo', 1]]]],
  )
  assert.deepEqual(plan.unphased, [])
})

test('same Idempotency-Key twice runs once, also when the two arrive together', async () => {
  const { tenant, auth } = await setup()
  const send = (key: string, taskKey: string) =>
    app.inject({
      method: 'POST',
      url: '/api/projects/alpha/tasks',
      headers: { ...auth, 'idempotency-key': key },
      payload: { key: taskKey, title: 'Once', phaseKey: 'P0' },
    })

  const first = await send('k-1', 'P0-T01')
  const second = await send('k-1', 'P0-T01')
  assert.equal(first.statusCode, 200)
  assert.equal(second.statusCode, 200)
  assert.deepEqual(second.json(), first.json())

  const [a, b] = await Promise.all([send('k-2', 'P0-T02'), send('k-2', 'P0-T02')])
  assert.deepEqual([a.statusCode, b.statusCode], [200, 200])
  assert.deepEqual(a.json(), b.json())

  const events = await t.admin
    .selectFrom('plan_events')
    .select('id')
    .where('tenant_id', '=', tenant.tenantId)
    .where('kind', '=', 'add_task')
    .execute()
  assert.equal(events.length, 2)
})

function words(code: 'DR306' | 'DR401', data: Record<string, unknown> = {}) {
  const { text, hint } = explain(code, data)
  return { text, hint }
}
