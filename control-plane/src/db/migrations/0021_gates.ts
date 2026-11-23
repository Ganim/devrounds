import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'
import { isolate } from './0001_core.ts'

// A gate is a repo's checks for one worktree, run as the batch it owns (gates/service.ts). Every check is pinned to
// the gate's machine, since they share the worktree. cwd is as the caller spelled it, cwd_key its normalized form
// (gates/file.ts normalizeCwd), the key of the worktree lock: at most one running gate per project, machine and
// cwd_key. A gate ends (finished_at) in the transaction where its batch's last open job ends, and only once.
const TABLES = [
  `create table gates (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants (id),
    project_id uuid not null,
    key text not null check (length(key) between 1 and 200),
    machine_id uuid not null,
    cwd text not null,
    cwd_key text not null,
    head_sha text check (head_sha ~ '^[0-9a-f]{7,64}$'),
    dirty boolean,
    batch_id uuid not null unique,
    state text not null default 'running' check (state in ('running', 'passed', 'failed', 'cancelled')),
    created_by uuid not null,
    created_at timestamptz not null default now(),
    finished_at timestamptz,
    check ((state = 'running') = (finished_at is null)),
    unique (tenant_id, id),
    foreign key (tenant_id, project_id) references projects (tenant_id, id),
    foreign key (tenant_id, machine_id) references machines (tenant_id, id),
    foreign key (tenant_id, batch_id) references job_batches (tenant_id, id),
    foreign key (tenant_id, created_by) references members (tenant_id, id)
  )`,
]

// Same reason as 0007_fk_indexes: one index per composite FK the constraints above do not already lead with.
const FK_INDEXES: [table: string, column: string][] = [
  ['gates', 'project_id'],
  ['gates', 'machine_id'],
  ['gates', 'batch_id'],
  ['gates', 'created_by'],
]

export const gates: Migration = {
  async up(db: Kysely<unknown>) {
    const statements = [
      ...TABLES,
      ...isolate('gates', 'tenant_id'),
      ...FK_INDEXES.map(([table, column]) => `create index ${table}_${column} on ${table} (tenant_id, ${column})`),
      // The worktree lock. submitGate serializes submits of one worktree with an advisory lock first, so a second
      // submit reads the holder and answers DR308; this index is the guarantee behind it.
      `create unique index gates_worktree_lock on gates (project_id, machine_id, cwd_key) where state = 'running'`,
    ]
    for (const statement of statements) await sql.raw(statement).execute(db)
  },
}
