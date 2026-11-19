import { sql } from 'kysely'
import type { Trx } from '../planning/resolve.ts'

export const SCHEDULER_CHANNEL = 'devrounds_scheduler'

/**
 * Wakes the scheduler for `tenantId`. Postgres delivers a NOTIFY only when `trx` commits (and drops it on rollback),
 * so a listener that claims on the wake already sees the rows this transaction wrote. The payload is the tenant id
 * only: listeners are not tenant-scoped, and the id tells them where to look without carrying any tenant data.
 */
export async function notifyScheduler(trx: Trx, tenantId: string): Promise<void> {
  await sql`select pg_notify(${SCHEDULER_CHANNEL}, ${tenantId})`.execute(trx)
}
