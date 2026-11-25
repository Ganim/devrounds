import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'
import { isolate } from './0001_core.ts'

// A project's conventions, one immutable row per version (conventions/service.ts). Only state, the decision and its
// reason ever change: proposed → active | rejected | withdrawn, active → superseded. A decision is a human member's
// (DR453), so decided_by is set exactly on the states a decision made: active, superseded (it was active) and
// rejected. A withdrawn proposal was replaced by the next propose, which is not a decision. based_on is the active
// version when it was proposed (null for the first); approve answers DR310 if another version became active since.
const TABLES = [
  `create table convention_sets (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants (id),
    project_id uuid not null,
    version integer not null check (version >= 1),
    state text not null default 'proposed'
      check (state in ('proposed', 'active', 'superseded', 'rejected', 'withdrawn')),
    document jsonb not null,
    document_sha text not null check (document_sha ~ '^[0-9a-f]{64}$'),
    based_on integer check (based_on >= 1 and based_on < version),
    head_sha text check (head_sha ~ '^[0-9a-f]{7,64}$'),
    task_id uuid not null,
    proposed_by uuid not null,
    proposed_at timestamptz not null default now(),
    decided_by uuid,
    decided_at timestamptz,
    reason text,
    check ((decided_at is null) = (decided_by is null)),
    check ((state in ('proposed', 'withdrawn')) = (decided_at is null)),
    check (state <> 'rejected' or reason is not null),
    unique (tenant_id, id),
    unique (project_id, version),
    foreign key (tenant_id, project_id) references projects (tenant_id, id),
    foreign key (tenant_id, task_id) references tasks (tenant_id, id),
    foreign key (tenant_id, proposed_by) references members (tenant_id, id),
    foreign key (tenant_id, decided_by) references members (tenant_id, id)
  )`,
]

// Same reason as 0007_fk_indexes: one index per composite FK the constraints above do not already lead with.
const FK_INDEXES: [table: string, column: string][] = [
  ['convention_sets', 'project_id'],
  ['convention_sets', 'task_id'],
  ['convention_sets', 'proposed_by'],
  ['convention_sets', 'decided_by'],
]

export const conventionSets: Migration = {
  async up(db: Kysely<unknown>) {
    const statements = [
      ...TABLES,
      ...isolate('convention_sets', 'tenant_id'),
      ...FK_INDEXES.map(([table, column]) => `create index ${table}_${column} on ${table} (tenant_id, ${column})`),
      // One active version and one open proposal per project. propose and decide serialize on the project row first,
      // so a caller reads the holder and answers DR311 or DR313; these indexes are the guarantee behind that.
      `create unique index convention_sets_active on convention_sets (project_id) where state = 'active'`,
      `create unique index convention_sets_proposed on convention_sets (project_id) where state = 'proposed'`,
    ]
    for (const statement of statements) await sql.raw(statement).execute(db)
  },
}
