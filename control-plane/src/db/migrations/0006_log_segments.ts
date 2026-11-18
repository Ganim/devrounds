import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'
import { isolate } from './0001_core.ts'
import type { MigrationOptions } from './index.ts'

// A run's output, as the executor shipped it: one row per segment, the zstd JSON lines in a file on the control
// plane's disk (`path`, absolute), indexed by the run's own line seqs. (run_id, first_seq) makes a resent segment a
// no-op and orders a run's segments for reading by cursor.
const TABLES = [
  `create table log_segments (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants (id),
    run_id uuid not null,
    first_seq bigint not null,
    last_seq bigint not null check (last_seq >= first_seq),
    records int not null,
    bytes int not null,
    path text not null,
    created_at timestamptz not null default now(),
    unique (run_id, first_seq),
    foreign key (tenant_id, run_id) references runs (tenant_id, id)
  )`,
  // The hourly prune looks for old segments across tenants.
  'create index log_segments_created on log_segments (created_at)',
]

// Why security definer: the prune runs for the whole control plane, before any tenant is chosen, and only learns
// which tenants hold expired segments here; each delete then happens inside that tenant (pruneLogSegments). Same
// hardening as resolve_token (0001): qualified names, pg_temp last, execute for the app role only.
const EXPIRED_LOG_SEGMENTS = `create function expired_log_segments(cutoff timestamptz)
  returns table (tenant_id uuid, id uuid, path text)
  language sql stable security definer set search_path = pg_catalog, public, pg_temp
  as $$
    select s.tenant_id, s.id, s.path from public.log_segments s where s.created_at < cutoff
  $$`

const FUNCTION = 'expired_log_segments(timestamptz)'

export function logSegments({ appRole }: MigrationOptions): Migration {
  return {
    async up(db: Kysely<unknown>) {
      const statements = [
        ...TABLES,
        ...isolate('log_segments', 'tenant_id'),
        EXPIRED_LOG_SEGMENTS,
        `revoke all on function ${FUNCTION} from public`,
      ]
      for (const statement of statements) await sql.raw(statement).execute(db)
      await sql`grant execute on function ${sql.raw(FUNCTION)} to ${sql.id(appRole)}`.execute(db)
    },
  }
}
