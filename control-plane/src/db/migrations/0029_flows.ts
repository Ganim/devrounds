import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'
import { isolate } from './0001_core.ts'
import type { MigrationOptions } from './index.ts'

// Flows (flows/engine.ts). A flow is a versioned document: one immutable row per (project, key, version), a new
// version only when the document's sha changes. A flow run pins the version it started on and belongs to a task; its
// node runs are its journal, one row per visit of a node, at most one open at a time (the node it waits on: a job or
// a wait). flow_key repeats the flow's key so the live-run lock spans versions: one running run per (project, flow
// key, source key), whichever version each started on; the composite FK keeps it equal to the flow row's key.
const TABLES = [
  `create table flows (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants (id),
    project_id uuid not null,
    key text not null check (key ~ '^[a-z][a-z0-9-]{0,99}$'),
    version integer not null check (version >= 1),
    document jsonb not null,
    document_sha text not null check (document_sha ~ '^[0-9a-f]{64}$'),
    created_by uuid not null,
    created_at timestamptz not null default now(),
    unique (tenant_id, id),
    unique (tenant_id, id, key),
    unique (project_id, key, version),
    foreign key (tenant_id, project_id) references projects (tenant_id, id),
    foreign key (tenant_id, created_by) references members (tenant_id, id)
  )`,
  `create table flow_runs (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants (id),
    project_id uuid not null,
    flow_id uuid not null,
    flow_key text not null,
    task_id uuid not null,
    source_key text check (length(source_key) between 1 and 300),
    state text not null default 'running' check (state in ('running', 'done', 'parked', 'cancelled')),
    input jsonb not null default '{}',
    reason text,
    created_by uuid not null,
    started_at timestamptz not null default now(),
    ended_at timestamptz,
    check ((state = 'running') = (ended_at is null)),
    check (state <> 'parked' or reason is not null),
    unique (tenant_id, id),
    foreign key (tenant_id, project_id) references projects (tenant_id, id),
    foreign key (tenant_id, flow_id, flow_key) references flows (tenant_id, id, key),
    foreign key (tenant_id, task_id) references tasks (tenant_id, id),
    foreign key (tenant_id, created_by) references members (tenant_id, id)
  )`,
  // seq orders a run's node runs (several are written in one transaction, at one now()). outcome is the label the
  // node left with (a job's done|failed|stopped, a branch case's label); data what a branch after it reads (a job's
  // run, exit_code, failure_class). A job node waits on job_id, a wait node on wake_at.
  `create table flow_node_runs (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants (id),
    flow_run_id uuid not null,
    node text not null,
    kind text not null check (kind in ('job', 'wait', 'branch', 'park', 'finish')),
    visit integer not null check (visit >= 1),
    seq integer not null check (seq >= 1),
    job_id uuid,
    wake_at timestamptz,
    outcome text,
    data jsonb not null default '{}',
    started_at timestamptz not null default now(),
    ended_at timestamptz,
    check ((outcome is null) = (ended_at is null)),
    check (kind = 'job' or job_id is null),
    check (kind = 'wait' or wake_at is null),
    unique (tenant_id, id),
    unique (flow_run_id, node, visit),
    unique (flow_run_id, seq),
    foreign key (tenant_id, flow_run_id) references flow_runs (tenant_id, id),
    foreign key (tenant_id, job_id) references jobs (tenant_id, id)
  )`,
]

// Same reason as 0007_fk_indexes: one index per composite FK the constraints above do not already lead with.
const FK_INDEXES: [table: string, column: string][] = [
  ['flows', 'project_id'],
  ['flows', 'created_by'],
  ['flow_runs', 'project_id'],
  ['flow_runs', 'task_id'],
  ['flow_runs', 'created_by'],
  ['flow_node_runs', 'flow_run_id'],
  ['flow_node_runs', 'job_id'],
]

// Why security definer: the scheduler tick looks for due waits of every tenant before any tenant is chosen, as
// due_schedules (0014) does; each wake then happens inside its tenant. Same hardening as resolve_token (0001).
const DUE_FLOW_WAITS = `create function due_flow_waits(p_now timestamptz)
  returns table (tenant_id uuid, flow_run_id uuid)
  language sql stable security definer set search_path = pg_catalog, public, pg_temp
  as $$
    select n.tenant_id, n.flow_run_id from public.flow_node_runs n
    where n.ended_at is null and n.wake_at is not null and n.wake_at <= p_now
  $$`

export function flows({ appRole }: MigrationOptions): Migration {
  return {
    async up(db: Kysely<unknown>) {
      const statements = [
        ...TABLES,
        ...['flows', 'flow_runs', 'flow_node_runs'].flatMap((table) => isolate(table, 'tenant_id')),
        ...FK_INDEXES.map(([table, column]) => `create index ${table}_${column} on ${table} (tenant_id, ${column})`),
        // The flow FK is three columns, so its index is too.
        'create index flow_runs_flow_id on flow_runs (tenant_id, flow_id, flow_key)',
        // One live run per flow and source key. startFlowRun serializes starts of one key with an advisory lock and
        // answers DR314 naming the holder; this index is the guarantee behind it.
        `create unique index flow_runs_live_source on flow_runs (project_id, flow_key, source_key)
          where state = 'running' and source_key is not null`,
        // The node a run waits on: at most one open node run per flow run.
        'create unique index flow_node_runs_open on flow_node_runs (flow_run_id) where ended_at is null',
        // A job belongs to at most one node run.
        'create unique index flow_node_runs_job on flow_node_runs (job_id) where job_id is not null',
        // Read across tenants by every tick; only open waits are in it.
        'create index flow_node_runs_due on flow_node_runs (wake_at) where ended_at is null and wake_at is not null',
        DUE_FLOW_WAITS,
        'revoke all on function due_flow_waits(timestamptz) from public',
      ]
      for (const statement of statements) await sql.raw(statement).execute(db)
      await sql`grant execute on function due_flow_waits(timestamptz) to ${sql.id(appRole)}`.execute(db)
    },
  }
}
