import { sql } from 'kysely'
import type { GateState } from '../db/schema.ts'
import type { Trx } from '../planning/resolve.ts'

/**
 * Ends the running gate of batch `batchId` once no job of the batch is open: failed when any job failed, else
 * cancelled when any was stopped or skipped, else passed. With no failed job every skip traces back to a person's stop
 * (skipDependents runs only from a failed or stopped end, retryRun skips only behind a red dependency, revoke and
 * orphan go through failed), so stopping a check that has dependents cancels the gate instead of failing it. Called where a job ends (jobs/outcome.ts endJob) and at
 * submit. A gate ends once: an ended gate stays as it is, so a person's retry of a check afterwards changes nothing,
 * and the worktree stays free. Apart from gates/service.ts (which re-exports it) so jobs/outcome.ts does not import
 * itself back through the gate views and runs/dispatch.ts: that cycle drops the websocket route types in tsc.
 */
export async function settleGate(trx: Trx, batchId: string): Promise<void> {
  // Locked before the jobs are read: two jobs of the batch ending at once in two transactions would each read the
  // other still open and neither would end the gate. The second waits here, then reads the first's commit.
  const gate = await trx
    .selectFrom('gates')
    .select('id')
    .where('batch_id', '=', batchId)
    .where('state', '=', 'running')
    .forNoKeyUpdate()
    .executeTakeFirst()
  if (!gate) return
  const { rows } = await sql<{ open: boolean; red: boolean; stopped: boolean }>`
    select bool_or(state = 'open') as open, bool_or(state = 'failed') as red,
      bool_or(state in ('stopped', 'skipped')) as stopped
    from jobs where batch_id = ${batchId}`.execute(trx)
  const jobs = rows[0]
  if (jobs.open) return
  const state: GateState = jobs.red ? 'failed' : jobs.stopped ? 'cancelled' : 'passed'
  await trx.updateTable('gates').set({ state, finished_at: sql<Date>`now()` }).where('id', '=', gate.id).execute()
}
