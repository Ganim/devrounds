import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'

// A job type's retry policy (jobs/outcome.ts applies it): how many attempts a job gets, the backoff before the
// second one (doubled per attempt, capped there), and the failure classes worth retrying. cancelled is a person's
// decision, never retried, and the check refuses it even from a write that skips the job type file validation.
const STATEMENTS = [
  'alter table job_types add column max_attempts int not null default 1 check (max_attempts between 1 and 10)',
  'alter table job_types add column retry_backoff_s int not null default 30 check (retry_backoff_s >= 0)',
  `alter table job_types add column retry_on text[] not null default '{infra}'
    check (retry_on <@ '{check_red,environment,timeout,memory,infra,unclassified}'::text[])`,
]

export const jobRetry: Migration = {
  async up(db: Kysely<unknown>) {
    for (const statement of STATEMENTS) await sql.raw(statement).execute(db)
  },
}
