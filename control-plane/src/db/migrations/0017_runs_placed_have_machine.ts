import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'

// A run has no machine while queued (0010) and gets one when the scheduler places it (claim_run, 0011). Nothing kept
// an offered, admitted or running run from having none, and one such run is unanswerable: expireOffers has no machine
// to close or name, so the offer never leaves `offered`. The check makes the state impossible; rows that already
// break it are offers that were never placed, so they go back to the queue the way an unplaced run is.
const STATEMENTS = [
  `update runs set state = 'queued', offered_at = null, offer_expires_at = null, offer_accepted_at = null
    where state = 'offered' and machine_id is null`,
  `alter table runs add constraint runs_placed_machine_check
    check (machine_id is not null or state not in ('offered', 'admitted', 'running'))`,
]

export const runsPlacedHaveMachine: Migration = {
  async up(db: Kysely<unknown>) {
    for (const statement of STATEMENTS) await sql.raw(statement).execute(db)
  },
}
