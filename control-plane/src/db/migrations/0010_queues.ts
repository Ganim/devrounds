import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'
import { isolate } from './0001_core.ts'

// The scheduler's schema: jobs wait in a queue of their project, may belong to a batch whose jobs depend on each other
// (job_dependencies), and are no longer tied to a machine (machine_id null = any machine, set = pinned). A queue with
// no queue_job_types row takes every job type. jobs.state is the job's outcome over all its runs.
const TABLES = [
  `create table queues (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants (id),
    project_id uuid not null,
    key text not null,
    priority int not null default 0,
    concurrency int check (concurrency > 0),
    created_at timestamptz not null default now(),
    unique (project_id, key),
    unique (tenant_id, id),
    foreign key (tenant_id, project_id) references projects (tenant_id, id)
  )`,
  `create table queue_job_types (
    tenant_id uuid not null references tenants (id),
    queue_id uuid not null,
    job_type_id uuid not null,
    primary key (queue_id, job_type_id),
    foreign key (tenant_id, queue_id) references queues (tenant_id, id),
    foreign key (tenant_id, job_type_id) references job_types (tenant_id, id)
  )`,
  `create table job_batches (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants (id),
    project_id uuid not null,
    created_by uuid not null,
    created_at timestamptz not null default now(),
    unique (tenant_id, id),
    foreign key (tenant_id, project_id) references projects (tenant_id, id),
    foreign key (tenant_id, created_by) references members (tenant_id, id)
  )`,
  `create table job_dependencies (
    tenant_id uuid not null references tenants (id),
    job_id uuid not null,
    depends_on_job_id uuid not null,
    primary key (job_id, depends_on_job_id),
    check (job_id <> depends_on_job_id),
    foreign key (tenant_id, job_id) references jobs (tenant_id, id),
    foreign key (tenant_id, depends_on_job_id) references jobs (tenant_id, id)
  )`,
]

// Runs as the owner (superuser), so the backfills see every tenant's rows despite forced RLS.
const JOBS = [
  'alter table jobs alter column machine_id drop not null',
  'alter table jobs add column queue_id uuid',
  // Every project that already has jobs gets its `default` queue, the one ensureQueue creates on first use.
  `insert into queues (tenant_id, project_id, key)
    select distinct tenant_id, project_id, 'default' from jobs`,
  `update jobs j set queue_id = q.id from queues q where q.project_id = j.project_id and q.key = 'default'`,
  'alter table jobs alter column queue_id set not null',
  'alter table jobs add foreign key (tenant_id, queue_id) references queues (tenant_id, id)',
  'alter table jobs add column batch_id uuid',
  'alter table jobs add foreign key (tenant_id, batch_id) references job_batches (tenant_id, id)',
  'alter table jobs add column ref text',
  'alter table jobs add unique (batch_id, ref)',
  `alter table jobs add column state text not null default 'open'
    check (state in ('open', 'finished', 'failed', 'stopped', 'skipped'))`,
  // A job's state is its last run's: a run not ended leaves it open, and orphaned (nobody saw it end) fails it.
  `update jobs j set state = case r.state
      when 'finished' then 'finished'
      when 'failed' then 'failed'
      when 'stopped' then 'stopped'
      when 'orphaned' then 'failed'
      else 'open' end
    from runs r
    where r.job_id = j.id and r.attempt = (select max(attempt) from runs last where last.job_id = j.id)`,
]

const RUNS = [
  // Null until the scheduler places the run.
  'alter table runs alter column machine_id drop not null',
  'alter table runs drop constraint runs_state_check',
  `alter table runs add constraint runs_state_check
    check (state in ('queued', 'offered', 'admitted', 'running', 'finished', 'failed', 'stopped', 'orphaned', 'skipped'))`,
  'alter table runs add column not_before timestamptz not null default now()',
  'alter table runs add column memory_need bigint',
  `alter table runs add column cause text not null default 'first' check (cause in ('first', 'retry', 'requeue'))`,
  // The scheduler's candidates: only queued runs, in the order they may start.
  `create index runs_queued on runs (tenant_id, not_before) where state = 'queued'`,
]

// Same reason as 0007_fk_indexes: one index per composite FK the constraints above do not already lead with.
const FK_INDEXES: [table: string, column: string][] = [
  ['queues', 'project_id'],
  ['queue_job_types', 'queue_id'],
  ['queue_job_types', 'job_type_id'],
  ['job_batches', 'project_id'],
  ['job_batches', 'created_by'],
  ['job_dependencies', 'job_id'],
  ['job_dependencies', 'depends_on_job_id'],
  ['jobs', 'queue_id'],
  ['jobs', 'batch_id'],
]

export const queues: Migration = {
  async up(db: Kysely<unknown>) {
    const statements = [
      ...TABLES,
      ...['queues', 'queue_job_types', 'job_batches', 'job_dependencies'].flatMap((table) =>
        isolate(table, 'tenant_id'),
      ),
      ...JOBS,
      ...RUNS,
      ...FK_INDEXES.map(([table, column]) => `create index ${table}_${column} on ${table} (tenant_id, ${column})`),
    ]
    for (const statement of statements) await sql.raw(statement).execute(db)
  },
}
