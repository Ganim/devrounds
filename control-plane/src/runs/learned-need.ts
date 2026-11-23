import { sql } from 'kysely'
import type { Trx } from '../planning/resolve.ts'

// 512 MiB, devlanes DEFAULT_MEMORY_NEED: what a job type is assumed to need before any run of it reported a peak.
// claim_run (migrations/0011_claim_run.ts) repeats it in SQL.
export const DEFAULT_MEMORY_NEED = 536870912n
const WINDOW = 10
// Samples from which the learned need replaces the job type's need_mb (claim_run, migrations/0019_placement.ts).
export const MIN_LEARNED_SAMPLES = 3

// The peaks of the last WINDOW runs of the key that reported one, ascending.
async function recentPeaks(trx: Trx, projectId: string, jobTypeId: string, machineId: string): Promise<bigint[]> {
  const rows = await trx
    .selectFrom('runs')
    .select('peak_private_bytes')
    .where('project_id', '=', projectId)
    .where('job_type_id', '=', jobTypeId)
    .where('machine_id', '=', machineId)
    .where('peak_private_bytes', 'is not', null)
    .orderBy('finished_at', 'desc')
    .orderBy('id')
    .limit(WINDOW)
    .execute()
  return rows.map((row) => BigInt(row.peak_private_bytes as string)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

// Mean of the middle pair, rounded half up, like the executor's median. Empty: DEFAULT_MEMORY_NEED.
function median(peaks: bigint[]): bigint {
  if (peaks.length === 0) return DEFAULT_MEMORY_NEED
  const middle = Math.floor(peaks.length / 2)
  if (peaks.length % 2 === 1) return peaks[middle]
  return (peaks[middle - 1] + peaks[middle] + 1n) / 2n
}

/**
 * Memory the next run of this job type on this machine is expected to need: the median peak of its last 10 runs that
 * reported one, else DEFAULT_MEMORY_NEED. Computed from the runs; storedNeed reads the same value from learned_needs.
 */
export async function learnedNeed(trx: Trx, projectId: string, jobTypeId: string, machineId: string): Promise<bigint> {
  return median(await recentPeaks(trx, projectId, jobTypeId, machineId))
}

/**
 * Recomputes the learned_needs row of the key from its runs. Called in the transaction that records a run's peak, so
 * the row never lags the runs it summarizes. A key without any peak keeps no row.
 * Two runs of the key finishing at once would each read the peaks without the other's uncommitted one, and the later
 * upsert would leave the row one peak behind; a lock per key, held to the commit, makes the second read wait for the
 * first commit (read committed: the read after the lock sees it).
 */
export async function updateLearnedNeed(
  trx: Trx,
  projectId: string,
  jobTypeId: string,
  machineId: string,
): Promise<void> {
  const key = `devrounds.learned_need:${projectId}:${jobTypeId}:${machineId}`
  await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(trx)
  const peaks = await recentPeaks(trx, projectId, jobTypeId, machineId)
  if (peaks.length === 0) return
  const need = median(peaks).toString()
  // The tenant comes from the machine row (RLS already limits it to the current tenant).
  await trx
    .insertInto('learned_needs')
    .columns(['tenant_id', 'project_id', 'job_type_id', 'machine_id', 'need_bytes', 'samples'])
    .expression((eb) =>
      eb
        .selectFrom('machines')
        .select([
          'tenant_id',
          eb.val(projectId).as('project_id'),
          eb.val(jobTypeId).as('job_type_id'),
          'id',
          eb.val(need).as('need_bytes'),
          eb.val(peaks.length).as('samples'),
        ])
        .where('id', '=', machineId),
    )
    .onConflict((oc) =>
      oc.columns(['project_id', 'job_type_id', 'machine_id']).doUpdateSet((eb) => ({
        need_bytes: eb.ref('excluded.need_bytes'),
        samples: eb.ref('excluded.samples'),
        updated_at: eb.fn('now'),
      })),
    )
    .execute()
}

/**
 * The need of the key as claim_run sees it (same rule as migrations/0019_placement.ts): the learned_needs row from
 * MIN_LEARNED_SAMPLES samples on, else the job type's need_mb, else the row, else DEFAULT_MEMORY_NEED.
 */
export async function storedNeed(trx: Trx, projectId: string, jobTypeId: string, machineId: string): Promise<bigint> {
  const type = await trx.selectFrom('job_types').select('need_bytes').where('id', '=', jobTypeId).executeTakeFirst()
  const row = await trx
    .selectFrom('learned_needs')
    .select(['need_bytes', 'samples'])
    .where('project_id', '=', projectId)
    .where('job_type_id', '=', jobTypeId)
    .where('machine_id', '=', machineId)
    .executeTakeFirst()
  if (row && row.samples >= MIN_LEARNED_SAMPLES) return BigInt(row.need_bytes)
  if (type?.need_bytes != null) return BigInt(type.need_bytes)
  return row ? BigInt(row.need_bytes) : DEFAULT_MEMORY_NEED
}
