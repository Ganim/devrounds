import type { Trx } from '../planning/resolve.ts'

// 512 MiB, devlanes DEFAULT_MEMORY_NEED: what a job type is assumed to need before any run of it reported a peak.
export const DEFAULT_MEMORY_NEED = 536870912n
const WINDOW = 10

/**
 * Memory the next run of this job type on this machine is expected to need: the median peak of its last 10 runs that
 * reported one (mean of the middle pair, rounded, like the executor's median), else DEFAULT_MEMORY_NEED.
 */
export async function learnedNeed(trx: Trx, projectId: string, jobTypeId: string, machineId: string): Promise<bigint> {
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
  if (rows.length === 0) return DEFAULT_MEMORY_NEED
  const peaks = rows.map((row) => BigInt(row.peak_private_bytes as string)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const middle = Math.floor(peaks.length / 2)
  if (peaks.length % 2 === 1) return peaks[middle]
  return (peaks[middle - 1] + peaks[middle] + 1n) / 2n
}
