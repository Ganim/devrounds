import { sql } from 'kysely'
import { authDb, authOptions } from './session.ts'

// Creates or upgrades Better Auth's tables in schema `auth` (created by migrations/0016_auth.ts) on the owner
// connection, then grants the app role DML on them. The default privileges of 0016 cover tables the owner creates later;
// the explicit grant covers tables whatever role created them. Runs from migrateToLatest under its advisory lock, so
// parallel migrators never race on the same tables. The port only names Better Auth's base URL here.
export async function migrateAuth(adminUrl: string, appRole: string, secret: string): Promise<void> {
  const { getMigrations } = await import('better-auth/db/migration')
  const db = authDb(adminUrl)
  try {
    const { runMigrations } = await getMigrations(authOptions(db, { port: 0, secret }))
    await runMigrations()
    await sql`grant select, insert, update, delete on all tables in schema auth to ${sql.id(appRole)}`.execute(db)
  } finally {
    await db.destroy()
  }
}
