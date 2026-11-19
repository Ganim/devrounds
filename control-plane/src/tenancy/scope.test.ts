import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { sql } from 'kysely'
import { migrateToLatest } from '../db/migrate.ts'
import { foreignKeysWithoutIndex, tablesWithoutTenantPolicy } from '../test-support/catalog.ts'
import {
  isolatedTestDb,
  TEST_ADMIN_URL,
  TEST_APP_PASSWORD,
  TEST_APP_ROLE,
  TEST_AUTH_SECRET,
  TEST_DATABASE_URL,
  testDb,
} from '../test-support/db.ts'
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

test('every public table has forced RLS and the tenant policy', async () => {
  const { admin } = await testDb()
  assert.deepEqual(await tablesWithoutTenantPolicy(admin), [])
})

test('every foreign key has an index leading with its referencing columns', async () => {
  const { admin } = await testDb()
  assert.deepEqual(await foreignKeysWithoutIndex(admin), [])
})

// The probe schemas live in a database of their own: in the shared one, another file's migrator lists every schema and
// then reads the tables of each, and fails on a probe schema dropped in between (3F000).
test('the foreign key guard flags a key whose columns are not the leading columns of any index', async () => {
  const { admin } = await isolatedTestDb('guard_probe')
  const schema = `guard_probe_${randomBytes(4).toString('hex')}`
  await sql.raw(`create schema ${schema}`).execute(admin)
  try {
    await sql.raw(`create table ${schema}.parent (tenant_id uuid, id uuid, unique (tenant_id, id))`).execute(admin)
    await sql
      .raw(`create table ${schema}.child (
        tenant_id uuid, parent_id uuid, other_id uuid, extra_id uuid,
        constraint fk_covered foreign key (tenant_id, parent_id) references ${schema}.parent (tenant_id, id),
        constraint fk_trailing foreign key (tenant_id, other_id) references ${schema}.parent (tenant_id, id),
        constraint fk_reordered foreign key (parent_id, other_id) references ${schema}.parent (tenant_id, id),
        constraint fk_included foreign key (tenant_id, extra_id) references ${schema}.parent (tenant_id, id))`)
      .execute(admin)
    await sql.raw(`create index on ${schema}.child (parent_id, tenant_id)`).execute(admin)
    // Leads with (parent_id, other_id): covers `fk_reordered`, but not `fk_trailing` (tenant_id, other_id).
    await sql.raw(`create index on ${schema}.child (parent_id, other_id, tenant_id)`).execute(admin)

    // INCLUDE columns are payload, not search keys: the index leads with tenant_id only, so `fk_included` is bare.
    await sql.raw(`create index on ${schema}.child (tenant_id) include (extra_id)`).execute(admin)

    assert.deepEqual(await foreignKeysWithoutIndex(admin, schema), [
      `${schema}.child.fk_included`,
      `${schema}.child.fk_trailing`,
    ])
  } finally {
    await sql.raw(`drop schema ${schema} cascade`).execute(admin)
  }
})

test('the tenant policy guard flags a policy with the right name and a different expression', async () => {
  const { admin } = await isolatedTestDb('guard_probe')
  const schema = `guard_probe_${randomBytes(4).toString('hex')}`
  const policy = sql.raw(`create policy tenant_isolation on ${schema}`)
  const wrong = sql.raw(`using (true) with check (true)`)
  await sql.raw(`create schema ${schema}`).execute(admin)
  try {
    for (const table of ['good', 'wrong_expression', 'wrong_check']) {
      await sql.raw(`create table ${schema}.${table} (tenant_id uuid not null)`).execute(admin)
      await sql.raw(`alter table ${schema}.${table} enable row level security`).execute(admin)
      await sql.raw(`alter table ${schema}.${table} force row level security`).execute(admin)
    }
    const tenant = `nullif(current_setting('app.tenant_id', true), '')::uuid`
    await sql`${policy}.good using (tenant_id = ${sql.raw(tenant)}) with check (tenant_id = ${sql.raw(tenant)})`.execute(
      admin,
    )
    await sql`${policy}.wrong_expression ${wrong}`.execute(admin)
    await sql`${policy}.wrong_check using (tenant_id = ${sql.raw(tenant)}) with check (true)`.execute(admin)

    assert.deepEqual(await tablesWithoutTenantPolicy(admin, schema), ['wrong_check', 'wrong_expression'])
  } finally {
    await sql.raw(`drop schema ${schema} cascade`).execute(admin)
  }
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
  await assert.rejects(
    migrateToLatest(TEST_DATABASE_URL, { appRole: 'devrounds_test_other', authSecret: TEST_AUTH_SECRET }),
    {
      code: 'DR502',
      message: /must be a superuser/,
    },
  )
})

test('migrateToLatest refuses the admin role as the app role', async () => {
  await assert.rejects(migrateToLatest(TEST_ADMIN_URL, { appRole: 'postgres', authSecret: TEST_AUTH_SECRET }), {
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
  await migrateToLatest(TEST_ADMIN_URL, {
    appRole: TEST_APP_ROLE,
    appPassword: TEST_APP_PASSWORD,
    authSecret: TEST_AUTH_SECRET,
  })
  assert.equal(await version(), before)
})
