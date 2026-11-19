import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'
import { isolate } from './0001_core.ts'
import type { MigrationOptions } from './index.ts'

// A schedule enqueues a job of its project on a clock: every_s seconds after the last fire, or daily_at (wall clock
// of the tenant time zone). next_due_at is the only clock; the scheduler tick fires what is due (scheduler/schedules.ts)
// and moves it past now, so a long outage fires once. last_job_id is the job the previous fire made, which the next
// fire waits on while it is open.
const TABLES = [
  `create table schedules (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants (id),
    project_id uuid not null,
    key text not null,
    job_type_id uuid not null,
    cwd text not null,
    queue_id uuid not null,
    machine_id uuid,
    every_s int check (every_s >= 60),
    daily_at time,
    enabled boolean not null default true,
    next_due_at timestamptz not null,
    last_job_id uuid,
    created_by uuid not null,
    updated_at timestamptz not null default now(),
    check (num_nonnulls(every_s, daily_at) = 1),
    unique (project_id, key),
    unique (tenant_id, id),
    foreign key (tenant_id, project_id) references projects (tenant_id, id),
    foreign key (tenant_id, job_type_id) references job_types (tenant_id, id),
    foreign key (tenant_id, queue_id) references queues (tenant_id, id),
    foreign key (tenant_id, machine_id) references machines (tenant_id, id),
    foreign key (tenant_id, last_job_id) references jobs (tenant_id, id),
    foreign key (tenant_id, created_by) references members (tenant_id, id)
  )`,
]

const JOBS = [
  'alter table jobs add column schedule_id uuid',
  'alter table jobs add foreign key (tenant_id, schedule_id) references schedules (tenant_id, id)',
]

// Same reason as 0007_fk_indexes: one index per composite FK the constraints above do not already lead with.
const FK_INDEXES: [table: string, column: string][] = [
  ['schedules', 'project_id'],
  ['schedules', 'job_type_id'],
  ['schedules', 'queue_id'],
  ['schedules', 'machine_id'],
  ['schedules', 'last_job_id'],
  ['schedules', 'created_by'],
  ['jobs', 'schedule_id'],
]

// Why security definer: every tick looks for due schedules of every tenant before any tenant is chosen; each fire then
// happens inside its tenant. Same hardening as resolve_token (0001): qualified names, pg_temp last, execute for the
// app role only.
const DUE_SCHEDULES = `create function due_schedules(p_now timestamptz)
  returns table (tenant_id uuid, schedule_id uuid)
  language sql stable security definer set search_path = pg_catalog, public, pg_temp
  as $$
    select s.tenant_id, s.id from public.schedules s where s.enabled and s.next_due_at <= p_now
  $$`

export function schedules({ appRole }: MigrationOptions): Migration {
  return {
    async up(db: Kysely<unknown>) {
      const statements = [
        ...TABLES,
        ...isolate('schedules', 'tenant_id'),
        ...JOBS,
        ...FK_INDEXES.map(([table, column]) => `create index ${table}_${column} on ${table} (tenant_id, ${column})`),
        // Read across tenants by every tick; only enabled schedules are in it.
        'create index schedules_due on schedules (next_due_at) where enabled',
        DUE_SCHEDULES,
        'revoke all on function due_schedules(timestamptz) from public',
      ]
      for (const statement of statements) await sql.raw(statement).execute(db)
      await sql`grant execute on function due_schedules(timestamptz) to ${sql.id(appRole)}`.execute(db)
    },
  }
}
