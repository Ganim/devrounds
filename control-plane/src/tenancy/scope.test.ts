import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { sql } from 'kysely'
import { migrateToLatest } from '../db/migrate.ts'
import { TEST_ADMIN_URL, TEST_APP_PASSWORD, TEST_APP_ROLE, TEST_DATABASE_URL, testDb } from '../test-support/db.ts'
import { withTenant } from './scope.ts'

function hashOf(token: Buffer): Buffer {
  return createHash('sha256').update(token).digest()
}

async function insertProject(tenantId: string, key = 'devrounds'): Promise<string> {
  const { db } = await testDb()
  return withTenant(db, tenantId, async (trx) => {
    const row = await trx
      .insertInto('projects')
      .values({ tenant_id: tenantId, key, name: 'DevRounds' })
      .returning('id')
      .executeTakeFirstOrThrow()
    return row.id
  })
}

test('rows of another tenant are invisible', async () => {
  const { db, newTenant } = await testDb()
  const a = await newTenant()
  const b = await newTenant()
  await insertProject(b.tenantId)

  const seen = await withTenant(db, a.tenantId, async (trx) => ({
    projects: await trx.selectFrom('projects').select('tenant_id').execute(),
    members: await trx.selectFrom('members').select('tenant_id').execute(),
    tenants: await trx.selectFrom('tenants').select('id').execute(),
  }))

  assert.deepEqual(seen.projects, [])
  assert.deepEqual(
    seen.members.map((row) => row.tenant_id),
    [a.tenantId, a.tenantId],
  )
  assert.deepEqual(seen.tenants, [{ id: a.tenantId }])
})

test('query outside withTenant returns no rows', async () => {
  const { db, newTenant } = await testDb()
  const a = await newTenant()
  await insertProject(a.tenantId)

  assert.deepEqual(await db.selectFrom('projects').select('id').execute(), [])
  assert.deepEqual(await db.selectFrom('members').select('id').execute(), [])
  assert.deepEqual(await db.selectFrom('tenants').select('id').execute(), [])
})

test('insert with a foreign tenant_id is refused', async () => {
  const { db, newTenant } = await testDb()
  const a = await newTenant()
  const b = await newTenant()

  await assert.rejects(
    withTenant(db, a.tenantId, (trx) =>
      trx.insertInto('projects').values({ tenant_id: b.tenantId, key: 'devrounds', name: 'Foreign' }).execute(),
    ),
    { code: '42501', message: /row-level security/ },
  )
})

test('a task cannot reference a phase of another tenant', async () => {
  const { db, newTenant } = await testDb()
  const a = await newTenant()
  const b = await newTenant()
  const projectA = await insertProject(a.tenantId)
  const projectB = await insertProject(b.tenantId)
  const phaseB = await withTenant(db, b.tenantId, async (trx) => {
    const row = await trx
      .insertInto('phases')
      .values({ tenant_id: b.tenantId, project_id: projectB, key: 'P0', title: 'Foundation', position: 0 })
      .returning('id')
      .executeTakeFirstOrThrow()
    return row.id
  })

  await assert.rejects(
    withTenant(db, a.tenantId, (trx) =>
      trx
        .insertInto('tasks')
        .values({ tenant_id: a.tenantId, project_id: projectA, phase_id: phaseB, key: 'P0-T01', title: 'Leak' })
        .execute(),
    ),
    { code: '23503' },
  )
})

test('resolve_token finds the tenant of a valid token and nothing for a revoked one', async () => {
  const { db, newTenant } = await testDb()
  const a = await newTenant()
  const valid = randomBytes(32)
  const revoked = randomBytes(32)
  await withTenant(db, a.tenantId, (trx) =>
    trx
      .insertInto('api_tokens')
      .values([
        { tenant_id: a.tenantId, member_id: a.agent.id, token_hash: hashOf(valid) },
        { tenant_id: a.tenantId, member_id: a.human.id, token_hash: hashOf(revoked), revoked_at: new Date() },
      ])
      .execute(),
  )

  const resolve = (token: Buffer) =>
    sql<{ tenant_id: string; member_id: string; kind: string }>`select * from resolve_token(${hashOf(token)})`
      .execute(db)
      .then((result) => result.rows)

  assert.deepEqual(await resolve(valid), [{ tenant_id: a.tenantId, member_id: a.agent.id, kind: 'agent' }])
  assert.deepEqual(await resolve(revoked), [])
})

test('the app role cannot bypass RLS', async () => {
  const { db } = await testDb()
  const { rows } = await sql<{ rolsuper: boolean; rolbypassrls: boolean }>`
    select rolsuper, rolbypassrls from pg_roles where rolname = current_user`.execute(db)
  assert.deepEqual(rows, [{ rolsuper: false, rolbypassrls: false }])
})

// Why: a new table without forced RLS and the tenant policy leaks every tenant through the app role.
test('every public table has forced RLS and a tenant policy', async () => {
  const { admin } = await testDb()
  const { rows } = await sql<{ table: string }>`
    select c.relname as table
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and not (c.relrowsecurity and c.relforcerowsecurity
        and exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polname = 'tenant_isolation'))
    order by 1`.execute(admin)
  assert.deepEqual(rows, [])
})

test('resolve_token ignores temp tables that shadow api_tokens and members', async () => {
  const { db, newTenant } = await testDb()
  const a = await newTenant()
  const forged = randomBytes(32)

  const rows = await db.transaction().execute(async (trx) => {
    await sql`create temp table api_tokens (tenant_id uuid, member_id uuid, token_hash bytea, revoked_at timestamptz)
      on commit drop`.execute(trx)
    await sql`create temp table members (tenant_id uuid, id uuid, kind text) on commit drop`.execute(trx)
    await sql`insert into pg_temp.api_tokens values (${a.tenantId}, ${a.human.id}, ${hashOf(forged)}, null)`.execute(
      trx,
    )
    await sql`insert into pg_temp.members values (${a.tenantId}, ${a.human.id}, 'human')`.execute(trx)
    return (await sql`select * from resolve_token(${hashOf(forged)})`.execute(trx)).rows
  })

  assert.deepEqual(rows, [])
})

test('a link must point to exactly one of task or phase', async () => {
  const { db, newTenant } = await testDb()
  const a = await newTenant()

  await assert.rejects(
    withTenant(db, a.tenantId, (trx) =>
      trx.insertInto('links').values({ tenant_id: a.tenantId, kind: 'doc', ref: 'docs/design.md' }).execute(),
    ),
    { code: '23514' },
  )
})

test('migrateToLatest refuses an admin connection that is not a superuser', async () => {
  await testDb()
  await assert.rejects(migrateToLatest(TEST_DATABASE_URL, { appRole: 'devrounds_test_other' }), {
    code: 'DR502',
    message: /must be a superuser/,
  })
})

test('migrateToLatest refuses the admin role as the app role', async () => {
  await assert.rejects(migrateToLatest(TEST_ADMIN_URL, { appRole: 'postgres' }), {
    code: 'DR502',
    message: /must differ from the admin role/,
  })
})

// Roles are cluster-wide while the migration lock is per database, so test runs on two databases of one cluster
// raced on `alter role`. A role that already matches must not be written at all: an update makes a new row version.
test('migrateToLatest does not rewrite an app role whose attributes and password already match', async () => {
  const { admin } = await testDb()
  const version = async () =>
    (await sql<{ xmin: string }>`select xmin::text from pg_authid where rolname = ${TEST_APP_ROLE}`.execute(admin))
      .rows[0]?.xmin
  const before = await version()
  await migrateToLatest(TEST_ADMIN_URL, { appRole: TEST_APP_ROLE, appPassword: TEST_APP_PASSWORD })
  assert.equal(await version(), before)
})
