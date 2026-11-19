import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'
import type { MigrationOptions } from './index.ts'

// Why security definer: the scheduler looks for expired offers of every tenant before any tenant is chosen, and serve
// re-arms every pending offer at start; each expiry then happens inside its tenant (scheduler/expiry.ts). Same
// hardening as resolve_token (0001): qualified names, pg_temp last, execute for the app role only.
const EXPIRED_OFFERS = `create function expired_offers()
  returns table (tenant_id uuid, run_id uuid, machine_id uuid)
  language sql stable security definer set search_path = pg_catalog, public, pg_temp
  as $$
    select r.tenant_id, r.id, r.machine_id from public.runs r
    where r.state = 'offered' and r.offer_accepted_at is null and r.offer_expires_at < now()
  $$`

// A crash leaves offers whose clock ran while nobody could answer them; serve calls it before its first tick so each
// gets a full timeout once the executors reconnect.
const REARM_OFFERS = `create function rearm_offers(p_timeout_s int)
  returns int
  language sql volatile security definer set search_path = pg_catalog, public, pg_temp
  as $$
    with rearmed as (
      update public.runs r set offer_expires_at = now() + make_interval(secs => p_timeout_s)
      where r.state = 'offered' and r.offer_accepted_at is null
      returning 1
    )
    select count(*)::int from rearmed
  $$`

const FUNCTIONS = ['expired_offers()', 'rearm_offers(int)']

const STATEMENTS = [
  // Every tick reads it across tenants; only the few offers in flight are in it.
  `create index runs_offers_unaccepted on runs (offer_expires_at)
    where state = 'offered' and offer_accepted_at is null`,
  // An offer already answered with Delayed before this migration counts as accepted, as it would from now on.
  `update runs r set offer_accepted_at = d.first_at
    from (select run_id, min(at) as first_at from run_delays group by run_id) d
    where d.run_id = r.id and r.state = 'offered' and r.offer_accepted_at is null`,
  EXPIRED_OFFERS,
  REARM_OFFERS,
  ...FUNCTIONS.map((fn) => `revoke all on function ${fn} from public`),
]

export function offerExpiry({ appRole }: MigrationOptions): Migration {
  return {
    async up(db: Kysely<unknown>) {
      for (const statement of STATEMENTS) await sql.raw(statement).execute(db)
      for (const fn of FUNCTIONS) {
        await sql`grant execute on function ${sql.raw(fn)} to ${sql.id(appRole)}`.execute(db)
      }
    },
  }
}
