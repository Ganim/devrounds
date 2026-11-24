import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'

// A finding task (planning/findings.ts) carries the caller's `source_key`, the stable name of what it tracks (a lint
// rule, a flaky test, a failing gate check). At most one task of a project is open per key; a done or cancelled one
// leaves the key free, so the same finding can come back as a new task.
const STATEMENTS = [
  'alter table tasks add column source_key text check (length(source_key) between 1 and 300)',
  `create unique index tasks_open_source_key on tasks (project_id, source_key)
    where source_key is not null and state not in ('done', 'cancelled')`,
]

export const taskSourceKey: Migration = {
  async up(db: Kysely<unknown>) {
    for (const statement of STATEMENTS) await sql.raw(statement).execute(db)
  },
}
