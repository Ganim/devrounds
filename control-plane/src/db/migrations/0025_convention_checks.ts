import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'
import { isolate } from './0001_core.ts'

// One conventions check result per run (conventions/results.ts, design call 15), posted by `conventions check` while
// its run is running. blocking and warnings are the exact counts; violations keeps at most 500 of them, blocking
// first. source is `mechanical` (the diff checker) now; `review` is reserved for P4's judgment lens.
const TABLES = [
  `create table convention_checks (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants (id),
    project_id uuid not null,
    run_id uuid not null unique,
    set_id uuid not null,
    source text not null check (source in ('mechanical', 'review')),
    files_checked integer not null check (files_checked >= 0),
    blocking integer not null check (blocking >= 0),
    warnings integer not null check (warnings >= 0),
    violations jsonb not null check (jsonb_typeof(violations) = 'array' and jsonb_array_length(violations) <= 500),
    created_at timestamptz not null default now(),
    unique (tenant_id, id),
    foreign key (tenant_id, project_id) references projects (tenant_id, id),
    foreign key (tenant_id, run_id) references runs (tenant_id, id),
    foreign key (tenant_id, set_id) references convention_sets (tenant_id, id)
  )`,
]

// Same reason as 0007_fk_indexes: one index per composite FK the constraints above do not already lead with.
const FK_INDEXES: [table: string, column: string][] = [
  ['convention_checks', 'project_id'],
  ['convention_checks', 'run_id'],
  ['convention_checks', 'set_id'],
]

export const conventionChecks: Migration = {
  async up(db: Kysely<unknown>) {
    const statements = [
      ...TABLES,
      ...isolate('convention_checks', 'tenant_id'),
      ...FK_INDEXES.map(([table, column]) => `create index ${table}_${column} on ${table} (tenant_id, ${column})`),
      // Indicators read a project's checks by local day of created_at.
      'create index convention_checks_created on convention_checks (project_id, created_at)',
    ]
    for (const statement of statements) await sql.raw(statement).execute(db)
  },
}
