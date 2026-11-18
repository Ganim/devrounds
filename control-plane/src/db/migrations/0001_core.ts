import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'
import type { MigrationOptions } from './index.ts'

const TENANT_SETTING = `nullif(current_setting('app.tenant_id', true), '')::uuid`

// Every child FK is composite with tenant_id, so each parent also carries unique (tenant_id, id).
const TABLES = [
  `create table tenants (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    timezone text not null default 'America/Sao_Paulo'
  )`,
  `create table members (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants (id),
    kind text not null check (kind in ('human', 'agent')),
    name text not null,
    unique (tenant_id, name),
    unique (tenant_id, id)
  )`,
  `create table api_tokens (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants (id),
    member_id uuid not null,
    token_hash bytea not null unique,
    created_at timestamptz not null default now(),
    revoked_at timestamptz,
    foreign key (tenant_id, member_id) references members (tenant_id, id)
  )`,
  `create table projects (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants (id),
    key text not null,
    name text not null,
    unique (tenant_id, key),
    unique (tenant_id, id)
  )`,
  `create table phases (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants (id),
    project_id uuid not null,
    key text not null,
    title text not null,
    goal text not null default '',
    position int not null,
    state text not null default 'open' check (state in ('open', 'delivered')),
    delivered_at timestamptz,
    delivered_by uuid,
    unique (project_id, key),
    unique (tenant_id, id),
    foreign key (tenant_id, project_id) references projects (tenant_id, id),
    foreign key (tenant_id, delivered_by) references members (tenant_id, id)
  )`,
  `create table phase_dependencies (
    tenant_id uuid not null references tenants (id),
    phase_id uuid not null,
    blocked_by_phase_id uuid not null,
    primary key (phase_id, blocked_by_phase_id),
    check (phase_id <> blocked_by_phase_id),
    foreign key (tenant_id, phase_id) references phases (tenant_id, id),
    foreign key (tenant_id, blocked_by_phase_id) references phases (tenant_id, id)
  )`,
  `create table tasks (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants (id),
    project_id uuid not null,
    phase_id uuid,
    parent_id uuid,
    key text not null,
    title text not null,
    description text not null default '',
    state text not null default 'todo' check (state in ('todo', 'in_progress', 'blocked', 'done', 'cancelled')),
    assignee_id uuid,
    estimate_hours numeric,
    started_at timestamptz,
    finished_at timestamptz,
    version int not null default 0,
    unique (project_id, key),
    unique (tenant_id, id),
    foreign key (tenant_id, project_id) references projects (tenant_id, id),
    foreign key (tenant_id, phase_id) references phases (tenant_id, id),
    foreign key (tenant_id, parent_id) references tasks (tenant_id, id),
    foreign key (tenant_id, assignee_id) references members (tenant_id, id)
  )`,
  `create table task_dependencies (
    tenant_id uuid not null references tenants (id),
    task_id uuid not null,
    blocked_by_task_id uuid not null,
    primary key (task_id, blocked_by_task_id),
    check (task_id <> blocked_by_task_id),
    foreign key (tenant_id, task_id) references tasks (tenant_id, id),
    foreign key (tenant_id, blocked_by_task_id) references tasks (tenant_id, id)
  )`,
  `create table criteria (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants (id),
    task_id uuid,
    phase_id uuid,
    position int not null,
    text text not null,
    checked_at timestamptz,
    checked_by uuid,
    evidence text,
    check (num_nonnulls(task_id, phase_id) = 1),
    foreign key (tenant_id, task_id) references tasks (tenant_id, id),
    foreign key (tenant_id, phase_id) references phases (tenant_id, id),
    foreign key (tenant_id, checked_by) references members (tenant_id, id)
  )`,
  `create table links (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants (id),
    task_id uuid,
    phase_id uuid,
    kind text not null,
    ref text not null,
    title text,
    check (num_nonnulls(task_id, phase_id) = 1),
    foreign key (tenant_id, task_id) references tasks (tenant_id, id),
    foreign key (tenant_id, phase_id) references phases (tenant_id, id)
  )`,
  `create table plan_events (
    id bigserial primary key,
    tenant_id uuid not null references tenants (id),
    project_id uuid not null,
    task_id uuid,
    phase_id uuid,
    actor_id uuid not null,
    kind text not null,
    reason text,
    data jsonb not null default '{}',
    at timestamptz not null default now(),
    foreign key (tenant_id, project_id) references projects (tenant_id, id),
    foreign key (tenant_id, task_id) references tasks (tenant_id, id),
    foreign key (tenant_id, phase_id) references phases (tenant_id, id),
    foreign key (tenant_id, actor_id) references members (tenant_id, id)
  )`,
  `create index plan_events_tenant_project_id on plan_events (tenant_id, project_id, id)`,
  `create table idempotency_keys (
    tenant_id uuid not null references tenants (id),
    key text not null,
    response jsonb not null,
    created_at timestamptz not null default now(),
    primary key (tenant_id, key)
  )`,
]

const TENANT_TABLES = [
  'members',
  'api_tokens',
  'projects',
  'phases',
  'phase_dependencies',
  'tasks',
  'task_dependencies',
  'criteria',
  'links',
  'plan_events',
  'idempotency_keys',
]

// Shared with later migrations: every tenant table gets exactly this.
export function isolate(table: string, column: string): string[] {
  return [
    `alter table ${table} enable row level security`,
    // Why FORCE: without it the table owner skips the policy.
    `alter table ${table} force row level security`,
    `create policy tenant_isolation on ${table} using (${column} = ${TENANT_SETTING}) with check (${column} = ${TENANT_SETTING})`,
  ]
}

// Why security definer: token lookup happens before the tenant is known, so it must read across tenants.
// It exposes only the tenant and member of a live token, never the hashes themselves.
// It sees other tenants only because its owner (the superuser admin) bypasses RLS; migrateToLatest enforces that.
// Qualified names and pg_temp last: otherwise an app session could shadow the tables with temp tables of its own.
const RESOLVE_TOKEN = `create function resolve_token(hash bytea)
  returns table (tenant_id uuid, member_id uuid, kind text)
  language sql stable security definer set search_path = pg_catalog, public, pg_temp
  as $$
    select t.tenant_id, t.member_id, m.kind
    from public.api_tokens t
    join public.members m on m.tenant_id = t.tenant_id and m.id = t.member_id
    where t.token_hash = hash and t.revoked_at is null
  $$`

export function core({ appRole }: MigrationOptions): Migration {
  return {
    async up(db: Kysely<unknown>) {
      const statements = [
        ...TABLES,
        ...isolate('tenants', 'id'),
        ...TENANT_TABLES.flatMap((table) => isolate(table, 'tenant_id')),
        // Functions are executable by PUBLIC by default; only the app role may resolve tokens. The default
        // privilege covers functions added by later migrations; the explicit revoke covers this one regardless.
        'alter default privileges revoke execute on functions from public',
        RESOLVE_TOKEN,
        'revoke all on function resolve_token(bytea) from public',
      ]
      for (const statement of statements) await sql.raw(statement).execute(db)

      const role = sql.id(appRole)
      await sql`grant usage on schema public to ${role}`.execute(db)
      await sql`grant select, insert, update, delete on all tables in schema public to ${role}`.execute(db)
      await sql`grant usage on all sequences in schema public to ${role}`.execute(db)
      await sql`alter default privileges in schema public grant select, insert, update, delete on tables to ${role}`.execute(
        db,
      )
      await sql`alter default privileges in schema public grant usage on sequences to ${role}`.execute(db)
      await sql`grant execute on function resolve_token(bytea) to ${role}`.execute(db)
    },
  }
}
