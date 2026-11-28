import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { sql } from 'kysely'
import { createLogin, removeLogin } from '../admin.ts'
import { buildServer } from '../api/server.ts'
import { DevRoundsError } from '../errors/error.ts'
import { addPhase, createProject } from '../planning/service.ts'
import {
  TEST_ADMIN_URL,
  TEST_APP_ROLE,
  TEST_AUTH_SECRET,
  TEST_DATABASE_URL,
  type TestDb,
  testDb,
} from '../test-support/db.ts'
import { type SessionAuth, SIGN_IN_LIMIT, startAuth } from './session.ts'
import { createToken } from './tokens.ts'

// The port only names the base URL and the trusted origins; inject never listens.
const PORT = 4992
const ORIGIN = `http://127.0.0.1:${PORT}`

let t: TestDb
let sessionAuth: SessionAuth
let app: ReturnType<typeof buildServer>

before(async () => {
  t = await testDb()
  // Every test here signs in from the same address within seconds; the limiter has a test of its own below.
  sessionAuth = await startAuth({
    databaseUrl: TEST_DATABASE_URL,
    port: PORT,
    secret: TEST_AUTH_SECRET,
    signInLimit: { window: 60, max: 1000 },
  })
  app = buildServer({ db: t.db, logger: false, sessionAuth })
  await app.ready()
})

after(async () => {
  await app.close()
  await sessionAuth.close()
})

const authOptions = { adminUrl: TEST_ADMIN_URL, secret: TEST_AUTH_SECRET, port: PORT }

// A tenant with project `alpha` (phase P0) whose human member has a login.
async function setup(projectKey = 'alpha') {
  const tenant = await t.newTenant()
  const ctx = { db: t.db, tenantId: tenant.tenantId, actor: tenant.human }
  await createProject(ctx, { key: projectKey, name: 'Alpha' })
  await addPhase(ctx, { projectKey, key: 'P0', title: 'Foundation', goal: 'Ship it' })
  const tenantName = (
    await t.admin.selectFrom('tenants').select('name').where('id', '=', tenant.tenantId).executeTakeFirstOrThrow()
  ).name
  const email = `${randomUUID()}@devrounds.test`
  const password = await createLogin(t.admin, authOptions, { tenant: tenantName, member: 'human', email })
  return { tenant, tenantName, email, password }
}

const postSignIn = (server: typeof app, email: string, password: string, remoteAddress?: string) =>
  server.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: { origin: ORIGIN },
    payload: { email, password },
    remoteAddress,
  })

// The whole Set-Cookie line of the session cookie a sign-in sets.
async function signInCookie(email: string, password: string): Promise<string> {
  const res = await postSignIn(app, email, password)
  assert.equal(res.statusCode, 200, res.body)
  const cookies = [res.headers['set-cookie'] ?? []].flat()
  const session = cookies.find((c) => c.startsWith('devrounds.session_token='))
  assert.ok(session, `no session cookie in ${cookies.join(' | ')}`)
  return session
}

// The `name=value` of the session cookie, ready for a Cookie header.
const signIn = async (email: string, password: string): Promise<string> =>
  (await signInCookie(email, password)).split(';')[0]

const readPlan = (headers: Record<string, string>, key = 'alpha') =>
  app.inject({ method: 'GET', url: `/api/projects/${key}/plan`, headers })

test('a member logs in with email and password and reads the plan with the cookie', async () => {
  const { tenantName, email, password } = await setup()
  assert.equal(password.length, 20)
  const cookie = await signIn(email, password)

  const plan = await readPlan({ cookie })
  assert.equal(plan.statusCode, 200, plan.body)
  assert.deepEqual(plan.json().project, { key: 'alpha', name: 'Alpha' })

  const session = await app.inject({ method: 'GET', url: '/api/auth/get-session', headers: { cookie } })
  assert.equal(session.json().user.email, email)

  // Removing the login deletes the user and its sessions with it.
  await removeLogin(t.admin, { tenant: tenantName, member: 'human' })
  assert.equal((await readPlan({ cookie })).json().code, 'DR401')
})

// Script cannot read the cookie, a cross-site navigation post does not carry it, and plain http on loopback gets it.
test('the session cookie is HttpOnly, SameSite=Lax, Path=/ and not Secure on loopback', async () => {
  const { email, password } = await setup()
  const attributes = (await signInCookie(email, password))
    .split(';')
    .slice(1)
    .map((a) => a.trim().toLowerCase())
  assert.ok(attributes.includes('httponly'), attributes.join('; '))
  assert.ok(attributes.includes('samesite=lax'), attributes.join('; '))
  assert.ok(attributes.includes('path=/'), attributes.join('; '))
  assert.ok(!attributes.includes('secure'), attributes.join('; '))
})

test('sign-in answers 429 past the limit for that client address, and other addresses still sign in', async (tc) => {
  const limited = await startAuth({
    databaseUrl: TEST_DATABASE_URL,
    port: PORT,
    secret: TEST_AUTH_SECRET,
    silent: true,
  })
  const server = buildServer({ db: t.db, logger: false, sessionAuth: limited })
  tc.after(async () => {
    await server.close()
    await limited.close()
  })
  const { email, password } = await setup()
  // Better Auth's memory store is per process; a fresh address keeps this bucket apart from the other tests'.
  const address = `10.${[1, 2, 3].map(() => Math.floor(Math.random() * 250) + 1).join('.')}`
  for (let i = 0; i < SIGN_IN_LIMIT.max; i++) {
    assert.equal((await postSignIn(server, email, 'wrong password!', address)).statusCode, 401)
  }
  // Past the limit even the right password is refused.
  assert.equal((await postSignIn(server, email, password, address)).statusCode, 429)
  assert.equal((await postSignIn(server, email, password, '192.0.2.10')).statusCode, 200)
})

// Review Focus 4: a cross-site form carries the browser's cookie, never a Bearer token.
test('a POST with only the session cookie answers DR402 and changes nothing', async () => {
  const { tenant, email, password } = await setup()
  const cookie = await signIn(email, password)

  const res = await app.inject({
    method: 'POST',
    url: '/api/projects/alpha/tasks',
    headers: { cookie, origin: 'https://evil.example' },
    payload: { key: 'P0-T01', title: 'Planted', phaseKey: 'P0' },
  })
  assert.equal(res.statusCode, 403)
  assert.equal(res.json().code, 'DR402')
  assert.deepEqual(res.json().data, {
    method: 'POST',
    route: '/api/projects/alpha/tasks',
    reason: 'has no x-devrounds-action header',
  })
  const tasks = await t.admin.selectFrom('tasks').select('id').where('tenant_id', '=', tenant.tenantId).execute()
  assert.deepEqual(tasks, [])
})

const postTask = (headers: Record<string, string>, key = 'alpha') =>
  app.inject({
    method: 'POST',
    url: `/api/projects/${key}/tasks`,
    headers,
    payload: { key: 'P0-T01', title: 'From the web view', phaseKey: 'P0' },
  })

// P5 design call 6: a cookie write needs the action header (a cross-site form cannot set one and no CORS is granted)
// and, when the browser sends them, the server's own Origin and Sec-Fetch-Site same-origin.
test('a cookie write without x-devrounds-action or from another site answers DR402 and changes nothing', async () => {
  const { tenant, email, password } = await setup()
  const cookie = await signIn(email, password)
  const action = { 'x-devrounds-action': 'task.add' }
  const refused: [Record<string, string>, string][] = [
    [{ origin: ORIGIN }, 'has no x-devrounds-action header'],
    [{ ...action, 'x-devrounds-action': ' ' }, 'has no x-devrounds-action header'],
    [{ ...action, origin: 'https://evil.example' }, 'comes from another origin'],
    [{ ...action, origin: 'null' }, 'comes from another origin'],
    [{ ...action, origin: `http://127.0.0.1:${PORT + 1}` }, 'comes from another origin'],
    [{ ...action, 'sec-fetch-site': 'cross-site' }, 'is not a same-origin request'],
    [{ ...action, origin: ORIGIN, 'sec-fetch-site': 'same-site' }, 'is not a same-origin request'],
  ]
  for (const [headers, reason] of refused) {
    const res = await postTask({ cookie, ...headers })
    assert.equal(res.statusCode, 403, JSON.stringify(headers))
    assert.equal(res.json().code, 'DR402')
    assert.deepEqual(res.json().data, { method: 'POST', route: '/api/projects/alpha/tasks', reason })
  }
  const tasks = await t.admin.selectFrom('tasks').select('id').where('tenant_id', '=', tenant.tenantId).execute()
  assert.deepEqual(tasks, [])
})

test('a same-origin cookie write with x-devrounds-action acts as the signed-in member in its own tenant', async () => {
  const a = await setup('alpha')
  await setup('beta')
  const cookie = await signIn(a.email, a.password)
  const web = { cookie, 'x-devrounds-action': 'task.add', 'sec-fetch-site': 'same-origin' }

  const posted = await postTask({ ...web, origin: ORIGIN })
  assert.equal(posted.statusCode, 200, posted.body)
  const event = await t.admin
    .selectFrom('plan_events')
    .select(['tenant_id', 'actor_id'])
    .where('tenant_id', '=', a.tenant.tenantId)
    .where('task_id', 'is not', null)
    .executeTakeFirstOrThrow()
  assert.deepEqual(event, { tenant_id: a.tenant.tenantId, actor_id: a.tenant.human.id })

  // Origin is optional (call 6): the action header alone is what a cross-site form cannot send.
  const second = await app.inject({
    method: 'POST',
    url: '/api/projects/alpha/tasks',
    headers: { cookie, 'x-devrounds-action': 'task.add' },
    payload: { key: 'P0-T02', title: 'No Origin', phaseKey: 'P0' },
  })
  assert.equal(second.statusCode, 200, second.body)

  // The guard admits the request; RLS still keeps it in the session's tenant.
  const foreign = await postTask({ ...web, origin: ORIGIN }, 'beta')
  assert.equal(foreign.statusCode, 404)
  assert.equal(foreign.json().code, 'DR201')
})

test('a Bearer token wins over a cookie and a bad Bearer answers DR401 even with a valid cookie', async () => {
  const { tenant, email, password } = await setup()
  const cookie = await signIn(email, password)
  const token = await createToken(t.admin, tenant.tenantId, 'human', 'human')

  const posted = await app.inject({
    method: 'POST',
    url: '/api/projects/alpha/tasks',
    headers: { cookie, authorization: `Bearer ${token}` },
    payload: { key: 'P0-T01', title: 'Schema', phaseKey: 'P0' },
  })
  assert.equal(posted.statusCode, 200, posted.body)

  const bad = await readPlan({ cookie, authorization: `Bearer drt_${'A'.repeat(43)}` })
  assert.equal(bad.statusCode, 401)
  assert.equal(bad.json().code, 'DR401')
})

test('sign-up through /api/auth answers an error and creates no user', async () => {
  const email = `${randomUUID()}@devrounds.test`
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: { origin: ORIGIN },
    payload: { email, password: 'long enough password', name: 'Mallory' },
  })
  assert.ok(res.statusCode >= 400, `${res.statusCode} ${res.body}`)
  const { rows } = await sql`select 1 from auth."user" where email = ${email}`.execute(t.admin)
  assert.deepEqual(rows, [])
})

test('a user linked to no member answers DR401', async () => {
  const { tenant, email, password } = await setup()
  const cookie = await signIn(email, password)
  await t.admin.updateTable('members').set({ user_id: null }).where('tenant_id', '=', tenant.tenantId).execute()

  const res = await readPlan({ cookie })
  assert.equal(res.statusCode, 401)
  assert.equal(res.json().code, 'DR401')
})

test("a session of tenant A reading tenant B's project answers DR201", async () => {
  const a = await setup('alpha')
  await setup('beta')
  const cookie = await signIn(a.email, a.password)

  const res = await readPlan({ cookie }, 'beta')
  assert.equal(res.statusCode, 404)
  assert.equal(res.json().code, 'DR201')
  assert.deepEqual(res.json().data, { kind: 'project', key: 'beta' })
})

test('the app role has DML but no DDL on schema auth, and serve never creates it', async () => {
  const { rows: schema } = await sql<{ owner: string; usage: boolean; create: boolean }>`
    select pg_get_userbyid(n.nspowner) as owner,
      has_schema_privilege(${TEST_APP_ROLE}, n.oid, 'USAGE') as usage,
      has_schema_privilege(${TEST_APP_ROLE}, n.oid, 'CREATE') as create
    from pg_namespace n where n.nspname = 'auth'`.execute(t.admin)
  assert.deepEqual(schema, [{ owner: 'postgres', usage: true, create: false }])

  const { rows: tables } = await sql<{ table: string; owner: string; dml: boolean; other: boolean }>`
    select c.relname as table, pg_get_userbyid(c.relowner) as owner,
      bool_and(has_table_privilege(${TEST_APP_ROLE}, c.oid, p)) filter (where p in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')) as dml,
      bool_or(has_table_privilege(${TEST_APP_ROLE}, c.oid, p)) filter (where p in ('TRUNCATE', 'REFERENCES', 'TRIGGER')) as other
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p
    where n.nspname = 'auth' and c.relkind = 'r'
    group by c.relname, c.relowner
    order by 1`.execute(t.admin)
  assert.deepEqual(
    tables,
    ['account', 'session', 'user', 'verification'].map((table) => ({
      table,
      owner: 'postgres',
      dml: true,
      other: false,
    })),
  )

  // serve connects as the app role, so it could not create or alter the identity tables even if Better Auth tried.
  await assert.rejects(sql`create table auth.planted (id int)`.execute(t.db), { code: '42501' })
})

test('login create refuses an agent member (DR453)', async () => {
  const { tenantName } = await setup()
  await assert.rejects(
    createLogin(t.admin, authOptions, { tenant: tenantName, member: 'agent', email: `${randomUUID()}@devrounds.test` }),
    (err) => err instanceof DevRoundsError && err.code === 'DR453' && err.data.action === 'log in',
  )
})

test('login create refuses a member that already has a login', async () => {
  const { tenantName } = await setup()
  await assert.rejects(
    createLogin(t.admin, authOptions, { tenant: tenantName, member: 'human', email: `${randomUUID()}@devrounds.test` }),
    (err) =>
      err instanceof DevRoundsError &&
      err.code === 'DR101' &&
      err.data.path === '--member' &&
      err.data.reason === 'already has a login; remove it first',
  )
})

test('without authSecret /api/auth answers DR202 (no route) and tokens still work', async (tc) => {
  const plain = buildServer({ db: t.db, logger: false })
  tc.after(() => plain.close())
  const { tenant, email, password } = await setup()
  const cookie = await signIn(email, password)

  const session = await plain.inject({ method: 'GET', url: '/api/auth/get-session', headers: { cookie } })
  assert.equal(session.statusCode, 404)
  assert.equal(session.json().code, 'DR202')
  const signInOff = await plain.inject({ method: 'POST', url: '/api/auth/sign-in/email', payload: { email, password } })
  assert.equal(signInOff.json().code, 'DR202')

  assert.equal(
    (await plain.inject({ method: 'GET', url: '/api/projects/alpha/plan', headers: { cookie } })).json().code,
    'DR401',
  )
  const token = await createToken(t.admin, tenant.tenantId, 'human', 'human')
  const plan = await plain.inject({
    method: 'GET',
    url: '/api/projects/alpha/plan',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(plan.statusCode, 200)
})
