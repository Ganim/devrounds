import { type Kysely, sql } from 'kysely'
import { type MigrationProvider, Migrator } from 'kysely/migration'
import { fail } from '../errors/error.ts'
import { createDb } from './connection.ts'
import { migrations } from './migrations/index.ts'
import type { Database } from './schema.ts'

export type MigrateOptions = { appRole: string; appPassword?: string }

// Why a plain identifier: the role name ends up in DDL, which cannot take bind parameters.
const PLAIN_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/

// Why a separate schema: the app role gets DML on every table in public, and must not rewrite migration history.
const MIGRATION_SCHEMA = 'devrounds_migrations'

// Arbitrary constant shared by every process that migrates this database.
const MIGRATION_LOCK = 4_992_001

// Roles are cluster-wide, so each database names its own app role. Runs on every migrate so a new
// password from `devrounds-admin init` reaches an existing role, and a role edited by hand is pulled
// back to NOSUPERUSER NOBYPASSRLS.
async function ensureAppRole(db: Kysely<Database>, { appRole, appPassword }: MigrateOptions): Promise<void> {
  await db.transaction().execute(async (trx) => {
    // DDL takes no bind parameters; passing values through settings lets format() quote them.
    await sql`select set_config('devrounds.app_role', ${appRole}, true),
      set_config('devrounds.app_password', ${appPassword ?? ''}, true)`.execute(trx)
    await sql`do $$
      declare
        role_name text := current_setting('devrounds.app_role');
        new_password text := current_setting('devrounds.app_password');
      begin
        if not exists (select 1 from pg_roles where rolname = role_name) then
          execute format('create role %I', role_name);
        end if;
        execute format('alter role %I login nosuperuser nobypassrls', role_name);
        if new_password <> '' then
          execute format('alter role %I password %L', role_name, new_password);
        end if;
      end
    $$`.execute(trx)
  })
}

export async function migrateToLatest(adminUrl: string, options: MigrateOptions): Promise<void> {
  if (!PLAIN_IDENTIFIER.test(options.appRole)) {
    fail('DR502', { reason: `app role "${options.appRole}" must match ${PLAIN_IDENTIFIER}` })
  }
  const provider: MigrationProvider = { getMigrations: async () => migrations({ appRole: options.appRole }) }
  const admin = createDb(adminUrl)
  try {
    // A session lock on one connection serializes parallel test processes and concurrent admin runs.
    await admin.connection().execute(async (conn) => {
      await sql`select pg_advisory_lock(${MIGRATION_LOCK})`.execute(conn)
      try {
        await ensureAppRole(conn, options)
        const migrator = new Migrator({ db: conn, provider, migrationTableSchema: MIGRATION_SCHEMA })
        const { error } = await migrator.migrateToLatest()
        if (error) throw error
      } finally {
        await sql`select pg_advisory_unlock(${MIGRATION_LOCK})`.execute(conn)
      }
    })
  } finally {
    await admin.destroy()
  }
}
