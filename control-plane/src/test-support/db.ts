import { randomUUID } from 'node:crypto'
import { after } from 'node:test'
import { type Kysely, sql } from 'kysely'
import { createDb } from '../db/connection.ts'
import { migrateToLatest } from '../db/migrate.ts'
import type { Database, Member } from '../db/schema.ts'
import { TEST_ADMIN_URL, TEST_APP_PASSWORD, TEST_APP_ROLE, TEST_DATABASE_URL } from './test-db-urls.ts'

export { TEST_ADMIN_URL, TEST_APP_PASSWORD, TEST_APP_ROLE, TEST_DATABASE_URL }

const APP_PASSWORD = TEST_APP_PASSWORD

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

// The URL `url` with its database renamed to `database`.
function withDatabase(url: string, database: string): string {
  const parsed = new URL(url)
  parsed.pathname = `/${database}`
  return parsed.toString()
}

export type IsolatedTestDb = TestDb & { url: string }

const isolated = new Map<string, Promise<IsolatedTestDb>>()

/**
 * A database of its own, `<test database>_<name>`, created and migrated once, for a test file whose subject reads or
 * writes across tenants (expired_offers, rearm_offers), where another file's scheduler would act on its rows between
 * a test's setup and its assertions, or changes the catalog (probe schemas), which another file's migrator reads.
 * Each name belongs to one test file, whose tests run one after another.
 */
export function isolatedTestDb(name: string): Promise<IsolatedTestDb> {
  let pending = isolated.get(name)
  if (!pending) {
    pending = (async () => {
      const database = `${new URL(TEST_ADMIN_URL).pathname.slice(1)}_${name}`
      const owner = createDb(TEST_ADMIN_URL)
      try {
        await sql`create database ${sql.id(database)}`.execute(owner)
      } catch (err) {
        // 42P04: created by an earlier run.
        if ((err as { code?: string }).code !== '42P04') throw err
      } finally {
        await owner.destroy()
      }
      const adminUrl = withDatabase(TEST_ADMIN_URL, database)
      const url = withDatabase(TEST_DATABASE_URL, database)
      await migrateToLatest(adminUrl, { appRole: TEST_APP_ROLE, appPassword: APP_PASSWORD })
      const db = createDb(url)
      const admin = createDb(adminUrl)
      pools.push(db, admin)
      return { db, admin, url, newTenant: (tenantName?: string) => newTenant(admin, tenantName) }
    })()
    isolated.set(name, pending)
  }
  return pending
}
