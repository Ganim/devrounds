import { sql } from 'kysely'
import type { Trx } from '../planning/resolve.ts'

// How far back a finished run still answers for a cache_key. The key is the caller's (e.g. a tree hash), so a longer
// window only adds the risk of an input the key does not cover (a tool update, the machine) going stale.
export const CACHE_WINDOW_DAYS = 7

/**
 * The run a new job of `jobTypeId` with `cacheKey` is a hit of, or null: the newest by finished_at that finished
 * within CACHE_WINDOW_DAYS in the same project, of the same job type and key, and was not itself a hit (a hit's
 * window would otherwise roll forward with no run behind it). A failed, stopped or skipped run never answers.
 */
export async function findCachedRun(
  trx: Trx,
  projectId: string,
  jobTypeId: string,
  cacheKey: string,
): Promise<string | null> {
  const row = await trx
    .selectFrom('jobs as j')
    .innerJoin('runs as r', 'r.job_id', 'j.id')
    .select('r.id')
    .where('j.project_id', '=', projectId)
    .where('j.job_type_id', '=', jobTypeId)
    .where('j.cache_key', '=', cacheKey)
    .where('r.state', '=', 'finished')
    .where('r.cached_from_run_id', 'is', null)
    .where('r.finished_at', '>=', sql<Date>`now() - make_interval(days => ${CACHE_WINDOW_DAYS})`)
    .orderBy('r.finished_at', 'desc')
    .orderBy('r.id', 'desc')
    .limit(1)
    .executeTakeFirst()
  return row?.id ?? null
}
