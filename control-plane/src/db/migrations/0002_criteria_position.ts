import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'

// Backs the owner-row lock in addCriterion: a criterion position is unique within its task or phase.
// Nulls are distinct, so task criteria (phase_id null) and phase criteria (task_id null) never collide.
export const criteriaPosition: Migration = {
  async up(db: Kysely<unknown>) {
    await sql`create unique index criteria_task_position on criteria (task_id, position)`.execute(db)
    await sql`create unique index criteria_phase_position on criteria (phase_id, position)`.execute(db)
  },
}
