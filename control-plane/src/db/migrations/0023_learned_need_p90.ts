import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'

// The learned need is now the p90 of the last 10 peaks (runs/learned-need.ts says why), so the stored rows, computed as
// a median, are recomputed at once rather than as each key next finishes a run. percentile_disc(0.9) is the nearest
// rank, the ceil(0.9 n)-th peak ascending, as p90() in learned-need.ts. Same window as there: the last 10 peaks by
// finished_at desc, id. Runs as the owner (superuser), so it sees every tenant's rows.
const RECOMPUTE = `update learned_needs n
  set need_bytes = p.need, samples = p.samples, updated_at = now()
  from (
    select project_id, job_type_id, machine_id,
      percentile_disc(0.9) within group (order by peak_private_bytes) as need,
      count(*)::int as samples
    from (
      select project_id, job_type_id, machine_id, peak_private_bytes,
        row_number() over (partition by project_id, job_type_id, machine_id order by finished_at desc, id) as rank
      from runs
      where peak_private_bytes is not null and machine_id is not null
    ) recent
    where rank <= 10
    group by project_id, job_type_id, machine_id
  ) p
  where n.project_id = p.project_id and n.job_type_id = p.job_type_id and n.machine_id = p.machine_id`

export const learnedNeedP90: Migration = {
  async up(db: Kysely<unknown>) {
    await sql.raw(RECOMPUTE).execute(db)
  },
}
