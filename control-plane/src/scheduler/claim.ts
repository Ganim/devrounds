import { sql } from 'kysely'
import type { Trx } from '../planning/resolve.ts'

const RESERVE_CAP = 2n << 30n

/** Memory kept free on a machine of `total` bytes: a tenth, at most 2 GiB (the executor's `default_reserve`). */
export function defaultReserve(total: bigint): bigint {
  const tenth = total / 10n
  return tenth < RESERVE_CAP ? tenth : RESERVE_CAP
}

/**
 * Offers the next queued run that fits machine `machineId` (claim_run in migrations/0027_claim_running_need.ts: queue
 * priority, FIFO, pin, depends_on, queue cap, need ≤ free − reserve − in-flight needs), or null when none fits. In-flight
 * needs are the offered and admitted runs' needs plus the running ones' minus `runningUsedBytes` (placeable.ts
 * runningUsed), at least 0. Call it inside withTenant of the machine's tenant; a machine of another tenant, revoked or
 * unknown claims nothing. The run is offered when `trx` commits, so the Offer goes out after the commit.
 */
export async function claimRun(
  trx: Trx,
  machineId: string,
  o: { freeBytes: bigint; reserveBytes: bigint; runningUsedBytes?: bigint; offerTimeoutS: number },
): Promise<{ runId: string; memoryNeed: bigint } | null> {
  const { rows } = await sql<{ run_id: string; memory_need: string }>`
    select run_id, memory_need from claim_run(
      ${machineId}::uuid, ${o.freeBytes.toString()}::bigint, ${o.reserveBytes.toString()}::bigint, ${o.offerTimeoutS}::int,
      ${(o.runningUsedBytes ?? 0n).toString()}::bigint
    )`.execute(trx)
  const row = rows[0]
  return row ? { runId: row.run_id, memoryNeed: BigInt(row.memory_need) } : null
}
