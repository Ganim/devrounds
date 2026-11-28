import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'

// A job type's environment (provider and mode; null: none) and what a run of it read of its cwd's environment just
// before it started (environments/index.ts JobTypeEnvironment and RunEnvironment; null: no environment).
// Migrations take the next free number at merge (Kysely refuses one named below an applied one).
const STATEMENTS = [
  'alter table job_types add column environment jsonb',
  'alter table runs add column environment jsonb',
]

export const environments: Migration = {
  async up(db: Kysely<unknown>) {
    for (const statement of STATEMENTS) await sql.raw(statement).execute(db)
  },
}
