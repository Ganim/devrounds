import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'

// When a run became orphaned. Orphaned has no end stamp (nobody saw the run end), and the gateway's re-sent orphan
// Stops are bounded by how recently the run was orphaned (pendingOrphanStops), which no other column records.
export const runsOrphanedAt: Migration = {
  async up(db: Kysely<unknown>) {
    await sql`alter table runs add column orphaned_at timestamptz`.execute(db)
  },
}
