import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'
import { isolate } from './0001_core.ts'

// A job is what was asked (job type, machine, cwd, task); each attempt at it is a run. Times stamped by the executor
// are clamped to offered_at on write (runs/record.ts), so durations read straight from the columns.
const TABLES = [
  `create table job_types (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants (id),
    project_id uuid not null,
    key text not null,
    program text not null,
    args jsonb not null default '[]',
    env_allow text[] not null default '{}',
    timeout_s int not null default 3600,
    orphan_policy text not null default 'kill' check (orphan_policy in ('kill', 'let_finish')),
    classify jsonb not null default '[]',
    updated_at timestamptz not null default now(),
    unique (project_id, key),
    unique (tenant_id, id),
    foreign key (tenant_id, project_id) references projects (tenant_id, id)
  )`,
  `create table jobs (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants (id),
    project_id uuid not null,
    job_type_id uuid not null,
    task_id uuid,
    cwd text not null,
    machine_id uuid not null,
    created_by uuid not null,
    created_at timestamptz not null default now(),
    unique (tenant_id, id),
    foreign key (tenant_id, project_id) references projects (tenant_id, id),
    foreign key (tenant_id, job_type_id) references job_types (tenant_id, id),
    foreign key (tenant_id, task_id) references tasks (tenant_id, id),
    foreign key (tenant_id, machine_id) references machines (tenant_id, id),
    foreign key (tenant_id, created_by) references members (tenant_id, id)
  )`,
  `create table runs (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants (id),
    project_id uuid not null,
    job_id uuid not null,
    job_type_id uuid not null,
    machine_id uuid not null,
    attempt int not null default 1,
    state text not null default 'queued'
      check (state in ('queued', 'offered', 'admitted', 'running', 'finished', 'failed', 'stopped', 'orphaned')),
    queued_at timestamptz not null default now(),
    offered_at timestamptz,
    admitted_at timestamptz,
    started_at timestamptz,
    finished_at timestamptz,
    exit_code bigint,
    failure_class text
      check (failure_class in ('check_red', 'environment', 'timeout', 'memory', 'infra', 'cancelled', 'unclassified')),
    failure_summary text,
    log_cursor bigint,
    pid int,
    process_start_time bigint,
    boot_id text,
    peak_private_bytes bigint,
    p95_private_bytes bigint,
    p50_private_bytes bigint,
    cpu_seconds double precision,
    swept_processes int,
    visible_windows int,
    orphan_action text check (orphan_action in ('killed', 'let_finish')),
    clock_skew_ms int not null default 0,
    trace_id text,
    unique (job_id, attempt),
    unique (tenant_id, id),
    foreign key (tenant_id, project_id) references projects (tenant_id, id),
    foreign key (tenant_id, job_id) references jobs (tenant_id, id),
    foreign key (tenant_id, job_type_id) references job_types (tenant_id, id),
    foreign key (tenant_id, machine_id) references machines (tenant_id, id)
  )`,
  'create index runs_project_queued on runs (tenant_id, project_id, queued_at)',
  'create index runs_machine_state on runs (tenant_id, machine_id, state)',
  `create table run_steps (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants (id),
    run_id uuid not null,
    step int not null,
    name text not null,
    started_at timestamptz not null,
    finished_at timestamptz,
    outcome text check (outcome in ('finished', 'failed')),
    unique (run_id, step),
    foreign key (tenant_id, run_id) references runs (tenant_id, id)
  )`,
  `create table run_delays (
    id bigserial primary key,
    tenant_id uuid not null references tenants (id),
    run_id uuid not null,
    at timestamptz not null,
    reason text not null check (reason in ('memory', 'concurrency', 'memory_critical')),
    need_bytes bigint not null,
    available_bytes bigint,
    position int not null,
    foreign key (tenant_id, run_id) references runs (tenant_id, id)
  )`,
  // The run view lists a run's delays; without it that read scans every delay of the tenant.
  'create index run_delays_run on run_delays (run_id, id)',
]

export const runs: Migration = {
  async up(db: Kysely<unknown>) {
    const statements = [
      ...TABLES,
      ...['job_types', 'jobs', 'runs', 'run_steps', 'run_delays'].flatMap((table) => isolate(table, 'tenant_id')),
    ]
    for (const statement of statements) await sql.raw(statement).execute(db)
  },
}
