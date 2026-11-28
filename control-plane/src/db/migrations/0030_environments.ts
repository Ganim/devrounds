import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'

// A job type's environment (provider and mode; null: none) and what a run of it read of its cwd's environment just
// before it started (environments/index.ts JobTypeEnvironment and RunEnvironment; null: no environment). Numbered 0052
// because 0029-0051 are reserved for the other P4 tracks.
const STATEMENTS = ['alter table job_types add column environment jsonb', 'alter table runs add column environment jsonb']

export const environments: Migration = {
  async up(db: Kysely<unknown>) {
    for (const statement of STATEMENTS) await sql.raw(statement).execute(db)
  },
}
