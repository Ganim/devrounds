import { type Kysely, sql } from 'kysely'
import type { Database } from '../db/schema.ts'
import { CLOSE_OFFER_TIMEOUT, type Sessions } from '../executor/gateway.ts'
import { queueRetry } from '../jobs/outcome.ts'
import { runEvents } from '../runs/dispatch.ts'
import { nextRunState } from '../runs/states.ts'
import { withTenant } from '../tenancy/scope.ts'
import { notifyScheduler } from './notify.ts'
import type { SchedulerLog } from './scheduler.ts'

/**
 * Withdraws every offer its executor did not answer (no event of the run) before offer_expires_at, and requeues its
 * job; returns the withdrawn run ids. The scheduler runs it first in each tick. A withdrawn run is stopped with class
 * infra and `withdrawn_at`: the next HelloAck lists it, so an executor that took the offer late drops it, and a late
 * answer is refused like any to an ended run (DR351). The requeue is a new run of the same job, attempt + 1, cause
 * requeue, so it never counts toward max_attempts (jobs/outcome.ts) and the job stays open: the machine let the offer
 * run out, not the job. The job is not settled, as a stop would end it.
 *
 * The rows come from expired_offers (0013) across tenants; each is checked again under its row lock inside its tenant,
 * because an event may have accepted the offer since. A session still live for the machine is closed 4408 after the
 * commit: it took an offer and said nothing, so it may be wedged, and the executor reconnects as for any drop.
 */
export async function expireOffers(
  db: Kysely<Database>,
  sessions: Sessions,
  offerTimeoutS: number,
  log: SchedulerLog,
): Promise<string[]> {
  const { rows } = await sql<{ tenant_id: string; run_id: string; machine_id: string }>`
    select tenant_id, run_id, machine_id from expired_offers()`.execute(db)
  const withdrawn: string[] = []
  for (const row of rows) {
    try {
      const requeued = await withTenant(db, row.tenant_id, async (trx) => {
        const run = await trx
          .selectFrom('runs')
          .select(['job_id', 'state'])
          .where('id', '=', row.run_id)
          .where('state', '=', 'offered')
          .where('offer_accepted_at', 'is', null)
          .where('offer_expires_at', '<', sql<Date>`now()`)
          .forNoKeyUpdate()
          .executeTakeFirst()
        if (!run) return null
        // Only for the summary: a missing machine must never keep the offer from being withdrawn.
        const machine = await trx
          .selectFrom('machines')
          .select('name')
          .where('id', '=', row.machine_id)
          .executeTakeFirst()
        const name = machine?.name ?? row.machine_id
        const requeueId = await queueRetry(trx, row.tenant_id, run.job_id, sql<Date>`now()`, 'requeue')
        await trx
          .updateTable('runs')
          .set({
            state: nextRunState(run.state, 'stop', row.run_id).state,
            finished_at: sql<Date>`greatest(now(), offered_at)`,
            failure_class: 'infra',
            failure_summary: `offer not answered within ${offerTimeoutS} s by ${name}; requeued as run ${requeueId}`,
            withdrawn_at: sql<Date>`now()`,
          })
          .where('id', '=', row.run_id)
          .execute()
        await notifyScheduler(trx, row.tenant_id)
        return requeueId
      })
      if (requeued === null) continue
      withdrawn.push(row.run_id)
      log.warn({ run: row.run_id, machineId: row.machine_id, requeued }, 'offer expired; withdrawn and requeued')
      if (sessions.get(row.machine_id)) sessions.close(row.machine_id, CLOSE_OFFER_TIMEOUT)
      runEvents.emit('changed', row.run_id)
      runEvents.emit('changed', requeued)
    } catch (err) {
      // The database, usually; the offer is still expired, so the next tick tries again.
      log.error({ err, run: row.run_id }, 'offer expiry failed')
    }
  }
  return withdrawn
}
