import { randomUUID } from 'node:crypto'
import { after } from 'node:test'
import type { Kysely } from 'kysely'
import { createDb } from '../db/connection.ts'
import { migrateToLatest } from '../db/migrate.ts'
import type { Database, Member } from '../db/schema.ts'

// Tests run as their own role, not devrounds_app: roles are cluster-wide and the server sets a different password.
export const TEST_APP_ROLE = 'devrounds_test_app'
const APP_PASSWORD = 'devrounds'
export const TEST_DATABASE_URL =
  process.env.DEVROUNDS_TEST_DATABASE_URL ??
  `postgres://${TEST_APP_ROLE}:${APP_PASSWORD}@127.0.0.1:15433/devrounds_test`
export const TEST_ADMIN_URL =
  process.env.DEVROUNDS_TEST_ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:15433/devrounds_test'

export type TestTenant = { tenantId: string; human: Member; agent: Member }

export type TestDb = {
  // Connects as the app role, so RLS applies exactly as in the server.
  db: Kysely<Database>
  // Owner connection: bypasses RLS, for setup and catalog checks only.
  admin: Kysely<Database>
  newTenant(name?: string): Promise<TestTenant>
}

let pending: Promise<TestDb> | undefined
const pools: Kysely<Database>[] = []

// node --test runs each file in its own process and waits for open sockets, so close the pools at the end.
after(async () => {
  await Promise.all(pools.map((pool) => pool.destroy()))
})

async function newTenant(admin: Kysely<Database>, name = `tenant-${randomUUID()}`): Promise<TestTenant> {
  return admin.transaction().execute(async (trx) => {
    const { id: tenantId } = await trx.insertInto('tenants').values({ name }).returning('id').executeTakeFirstOrThrow()
    const [human, agent] = await trx
      .insertInto('members')
      .values([
        { tenant_id: tenantId, kind: 'human', name: 'human' },
        { tenant_id: tenantId, kind: 'agent', name: 'agent' },
      ])
      .returningAll()
      .execute()
    return { tenantId, human, agent }
  })
}

// Migrates once per process; tests isolate by creating fresh tenants, never by truncating.
export function testDb(): Promise<TestDb> {
  pending ??= (async () => {
    await migrateToLatest(TEST_ADMIN_URL, { appRole: TEST_APP_ROLE, appPassword: APP_PASSWORD })
    const db = createDb(TEST_DATABASE_URL)
    const admin = createDb(TEST_ADMIN_URL)
    pools.push(db, admin)
    return { db, admin, newTenant: (name?: string) => newTenant(admin, name) }
  })()
  return pending
}
