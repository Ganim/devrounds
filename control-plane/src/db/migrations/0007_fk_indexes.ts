import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'

// Postgres indexes the referenced side of a foreign key, never the referencing side. Without these, deleting or
// updating a parent row scans the whole child table, and every join through `(tenant_id, x_id)` is a seq scan.
// Only the composite FKs that no existing index led with; the guard in test-support/catalog.ts keeps it that way.
// Plain CREATE INDEX: the tables are small and the migration runs before the server accepts traffic.
const FK_INDEXES: [table: string, column: string][] = [
  ['api_tokens', 'member_id'],
  ['criteria', 'checked_by'],
  ['criteria', 'phase_id'],
  ['criteria', 'task_id'],
  ['job_types', 'project_id'],
  ['jobs', 'created_by'],
  ['jobs', 'job_type_id'],
  ['jobs', 'machine_id'],
  ['jobs', 'project_id'],
  ['jobs', 'task_id'],
  ['links', 'phase_id'],
  ['links', 'task_id'],
  ['log_segments', 'run_id'],
  ['pairing_codes', 'created_by'],
  ['phase_dependencies', 'blocked_by_phase_id'],
  ['phase_dependencies', 'phase_id'],
  ['phases', 'delivered_by'],
  ['phases', 'project_id'],
  ['plan_events', 'actor_id'],
  ['plan_events', 'phase_id'],
  ['plan_events', 'task_id'],
  ['run_delays', 'run_id'],
  ['run_steps', 'run_id'],
  ['runs', 'job_id'],
  ['runs', 'job_type_id'],
  ['task_dependencies', 'blocked_by_task_id'],
  ['task_dependencies', 'task_id'],
  ['tasks', 'assignee_id'],
  ['tasks', 'parent_id'],
  ['tasks', 'phase_id'],
  ['tasks', 'project_id'],
]

export const fkIndexes: Migration = {
  async up(db: Kysely<unknown>) {
    for (const [table, column] of FK_INDEXES) {
      await sql.raw(`create index ${table}_${column} on ${table} (tenant_id, ${column})`).execute(db)
    }
  },
}
