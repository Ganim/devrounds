import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'
import type { MigrationOptions } from './index.ts'

// Plan history is append-only at the role level: 0001 granted every table's DML to the app role, plan_events included.
export function planEventsAppendOnly({ appRole }: MigrationOptions): Migration {
  return {
    async up(db: Kysely<unknown>) {
      await sql`revoke update, delete on plan_events from ${sql.id(appRole)}`.execute(db)
    },
  }
}
