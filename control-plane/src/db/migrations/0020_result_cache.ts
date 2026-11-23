import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'

// A job may carry the caller's `cache_key` (e.g. a tree hash: DevRounds never reads the repo). When a finished run of
// the same project, job type and key ended within the window (jobs/cache.ts), the new job's run ends `finished` at
// once with `cached_from_run_id` naming that run; nothing ran, so it never counts as a run in the indicators.
const STATEMENTS = [
  'alter table jobs add column cache_key text check (length(cache_key) between 1 and 200)',
  'create index jobs_cache_key on jobs (project_id, job_type_id, cache_key) where cache_key is not null',
  'alter table runs add column cached_from_run_id uuid',
  `alter table runs add constraint runs_cached_from_fk
    foreign key (tenant_id, cached_from_run_id) references runs (tenant_id, id)`,
  'create index runs_cached_from on runs (tenant_id, cached_from_run_id)',
  `alter table runs add constraint runs_cached_finished_check
    check (cached_from_run_id is null or state = 'finished')`,
]

export const resultCache: Migration = {
  async up(db: Kysely<unknown>) {
    for (const statement of STATEMENTS) await sql.raw(statement).execute(db)
  },
}
