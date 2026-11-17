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

// Why superuser: resolve_token reads across tenants only because its owner bypasses RLS, and changing
// role attributes needs it too. Without it every token would silently resolve to nothing.
// Why refuse instead of demote: an app role that is the admin itself or another superuser is a config
// mistake, and demoting it would lock the operator out.
async function assertRoles(db: Kysely<Database>, appRole: string): Promise<void> {
  const { rows } = await sql<{ admin: string; admin_is_super: boolean; app_is_super: boolean | null }>`
    select current_user as admin,
      (select rolsuper from pg_roles where rolname = current_user) as admin_is_super,
      (select rolsuper from pg_roles where rolname = ${appRole}) as app_is_super`.execute(db)
  const [{ admin, admin_is_super, app_is_super }] = rows
  if (!admin_is_super) fail('DR502', { reason: `admin connection must be a superuser (connected as "${admin}")` })
  if (appRole === admin) fail('DR502', { reason: `app role "${appRole}" must differ from the admin role` })
  if (app_is_super) fail('DR502', { reason: `app role "${appRole}" is an existing superuser` })
}

// Roles are cluster-wide, so each database names its own app role. Runs on every migrate so a new
// password from `devrounds-admin init` reaches an existing role, and a role edited by hand loses BYPASSRLS.
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
      await assertRoles(conn, options.appRole)
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
