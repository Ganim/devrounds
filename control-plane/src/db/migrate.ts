import { createHash, createHmac, pbkdf2 as pbkdf2Callback } from 'node:crypto'
import { promisify } from 'node:util'
import { type Kysely, sql } from 'kysely'
import { type MigrationProvider, Migrator } from 'kysely/migration'
import { fail } from '../errors/error.ts'
import { createDb } from './connection.ts'
import { migrations } from './migrations/index.ts'
import type { Database } from './schema.ts'

const pbkdf2 = promisify(pbkdf2Callback)

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
//
// Roles are cluster-wide but MIGRATION_LOCK is per database, so runs on two databases of one cluster (parallel test
// lanes) can write the same pg_authid row at once and fail with "tuple concurrently updated". The role is therefore
// only written when it differs from what is wanted, and a lost race is retried once after re-reading.
async function ensureAppRole(db: Kysely<Database>, options: MigrateOptions): Promise<void> {
  try {
    await applyAppRole(db, options)
  } catch (err) {
    if (!isRoleRace(err)) throw err
    await applyAppRole(db, options)
  }
}

function isRoleRace(err: unknown): boolean {
  const { code, message } = err as { code?: string; message?: string }
  return code === '23505' || code === '42710' || /tuple concurrently updated/.test(message ?? '')
}

// True when `stored` (a pg_authid SCRAM-SHA-256 verifier) was made from `password`. Anything else, including a
// non-ASCII password that Postgres normalizes differently, counts as different and just causes a harmless alter.
async function passwordMatches(stored: string | null | undefined, password: string): Promise<boolean> {
  const match = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):/.exec(stored ?? '')
  if (!match) return false
  const [, iterations, salt, storedKey] = match
  const salted = await pbkdf2(password, Buffer.from(salt, 'base64'), Number(iterations), 32, 'sha256')
  const clientKey = createHmac('sha256', salted).update('Client Key').digest()
  return createHash('sha256').update(clientKey).digest('base64') === storedKey
}

async function applyAppRole(db: Kysely<Database>, { appRole, appPassword }: MigrateOptions): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const { rows } = await sql<{
      rolsuper: boolean
      rolbypassrls: boolean
      rolcanlogin: boolean
      rolpassword: string | null
    }>`
      select rolsuper, rolbypassrls, rolcanlogin, rolpassword from pg_authid where rolname = ${appRole}`.execute(trx)
    const [role] = rows
    const alterAttributes = !role || role.rolsuper || role.rolbypassrls || !role.rolcanlogin
    const alterPassword = !!appPassword && !(await passwordMatches(role?.rolpassword, appPassword))
    if (role && !alterAttributes && !alterPassword) return
    // DDL takes no bind parameters; passing values through settings lets format() quote them.
    await sql`select set_config('devrounds.app_role', ${appRole}, true),
      set_config('devrounds.app_password', ${alterPassword ? (appPassword ?? '') : ''}, true),
      set_config('devrounds.alter_attributes', ${alterAttributes ? 'yes' : ''}, true)`.execute(trx)
    await sql`do $$
      declare
        role_name text := current_setting('devrounds.app_role');
        new_password text := current_setting('devrounds.app_password');
      begin
        if not exists (select 1 from pg_roles where rolname = role_name) then
          execute format('create role %I', role_name);
        end if;
        if current_setting('devrounds.alter_attributes') <> '' then
          execute format('alter role %I login nosuperuser nobypassrls', role_name);
        end if;
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
