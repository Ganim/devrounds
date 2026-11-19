import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'
import type { MigrationOptions } from './index.ts'

// Why security definer: the sweep deletes expired keys of every tenant in one statement, and the app role only sees
// its own tenant's rows (RLS). Only a count leaves the function. Same hardening as expired_log_segments (0006):
// qualified names, pg_temp last, execute for the app role only.
const PRUNE_IDEMPOTENCY_KEYS = `create function prune_idempotency_keys(p_cutoff timestamptz)
  returns int
  language sql volatile security definer set search_path = pg_catalog, public, pg_temp
  as $$
    with pruned as (
      delete from public.idempotency_keys k where k.created_at < p_cutoff returning 1
    )
    select count(*)::int from pruned
  $$`

const FUNCTION = 'prune_idempotency_keys(timestamptz)'

export function idempotencySweep({ appRole }: MigrationOptions): Migration {
  return {
    async up(db: Kysely<unknown>) {
      await sql.raw(PRUNE_IDEMPOTENCY_KEYS).execute(db)
      await sql.raw(`revoke all on function ${FUNCTION} from public`).execute(db)
      await sql`grant execute on function ${sql.raw(FUNCTION)} to ${sql.id(appRole)}`.execute(db)
    },
  }
}
