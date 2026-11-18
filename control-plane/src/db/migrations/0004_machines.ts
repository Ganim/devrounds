import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'
import { isolate } from './0001_core.ts'
import type { MigrationOptions } from './index.ts'

// Tokens and codes are stored only as SHA-256; the plaintext leaves the server once, to the executor or the member.
const TABLES = [
  `create table machines (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants (id),
    name text not null,
    compute_provider text not null default 'local',
    lifecycle text not null default 'persistent' check (lifecycle in ('persistent', 'ephemeral')),
    token_hash bytea not null unique,
    os text not null,
    executor_version text not null,
    paired_at timestamptz not null default now(),
    revoked_at timestamptz,
    last_seen_at timestamptz,
    last_report jsonb,
    last_seq bigint not null default 0,
    unique (tenant_id, id)
  )`,
  // A revoked machine keeps its row (runs will point at it), so its name can be paired again.
  `create unique index machines_live_name on machines (tenant_id, name) where revoked_at is null`,
  `create table pairing_codes (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants (id),
    code_hash bytea not null unique,
    machine_name text not null,
    created_by uuid not null,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    used_at timestamptz,
    foreign key (tenant_id, created_by) references members (tenant_id, id)
  )`,
]

// Why security definer: an executor redeems a code and presents its token before any tenant is known, the same
// reason as resolve_token (0001). Same hardening: qualified names, pg_temp last, execute for the app role only.
// One statement, so marking the code used and creating the machine commit together or not at all, and the row lock
// of the update makes a second concurrent redemption of the same code find it used. Parameters share names with
// columns, so they are qualified with the function name.
const REDEEM_PAIRING_CODE = `create function redeem_pairing_code(code_hash bytea, token_hash bytea, os text, version text)
  returns table (tenant_id uuid, machine_id uuid, machine_name text)
  language sql volatile security definer set search_path = pg_catalog, public, pg_temp
  as $$
    with code as (
      update public.pairing_codes c set used_at = now()
      where c.code_hash = redeem_pairing_code.code_hash and c.used_at is null and c.expires_at > now()
      returning c.tenant_id, c.machine_name
    )
    insert into public.machines (tenant_id, name, token_hash, os, executor_version)
    select code.tenant_id, code.machine_name, redeem_pairing_code.token_hash, redeem_pairing_code.os,
      redeem_pairing_code.version
    from code
    returning machines.tenant_id, machines.id, machines.name
  $$`

const RESOLVE_MACHINE_TOKEN = `create function resolve_machine_token(hash bytea)
  returns table (tenant_id uuid, machine_id uuid)
  language sql stable security definer set search_path = pg_catalog, public, pg_temp
  as $$
    select m.tenant_id, m.id from public.machines m where m.token_hash = hash and m.revoked_at is null
  $$`

const FUNCTIONS = ['redeem_pairing_code(bytea, bytea, text, text)', 'resolve_machine_token(bytea)']

export function machines({ appRole }: MigrationOptions): Migration {
  return {
    async up(db: Kysely<unknown>) {
      const statements = [
        ...TABLES,
        ...isolate('machines', 'tenant_id'),
        ...isolate('pairing_codes', 'tenant_id'),
        REDEEM_PAIRING_CODE,
        RESOLVE_MACHINE_TOKEN,
        ...FUNCTIONS.map((fn) => `revoke all on function ${fn} from public`),
      ]
      for (const statement of statements) await sql.raw(statement).execute(db)
      for (const fn of FUNCTIONS) await sql`grant execute on function ${sql.raw(fn)} to ${sql.id(appRole)}`.execute(db)
    },
  }
}
