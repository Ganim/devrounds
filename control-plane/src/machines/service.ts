import { sql } from 'kysely'
import { fail } from '../errors/error.ts'
import type { Sessions } from '../executor/gateway.ts'
import type { MachineReport } from '../executor/protocol.ts'
import { type Ctx, run, type TenantCtx } from '../planning/resolve.ts'
import { requireHuman } from './pairing.ts'

// Close code for a session whose machine token stopped being valid; the executor then asks for a new pairing.
export const CLOSE_REVOKED = 4401

export type MachineView = {
  id: string
  name: string
  os: string
  executorVersion: string
  computeProvider: string
  lifecycle: string
  pairedAt: Date
  lastSeenAt: Date | null
  lastReport: unknown
}

/** Live (not revoked) machines of the tenant, by name. */
export function listMachines(ctx: TenantCtx): Promise<MachineView[]> {
  return run(ctx, async (trx) => {
    const rows = await trx
      .selectFrom('machines')
      .select([
        'id',
        'name',
        'os',
        'executor_version',
        'compute_provider',
        'lifecycle',
        'paired_at',
        'last_seen_at',
        'last_report',
      ])
      .where('revoked_at', 'is', null)
      .orderBy('name')
      .execute()
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      os: row.os,
      executorVersion: row.executor_version,
      computeProvider: row.compute_provider,
      lifecycle: row.lifecycle,
      pairedAt: row.paired_at,
      lastSeenAt: row.last_seen_at,
      lastReport: row.last_report,
    }))
  })
}

/**
 * Revokes the live machine `name` and closes its session. The close runs before the transaction commits; a session
 * that starts in between still sees the revocation, because recordHello's update waits on this row lock.
 */
export async function revokeMachine(ctx: Ctx, sessions: Sessions, name: string): Promise<{ name: string }> {
  requireHuman(ctx, 'revoke a machine')
  return run(ctx, async (trx) => {
    const row = await trx
      .updateTable('machines')
      .set({ revoked_at: sql<Date>`now()` })
      .where('name', '=', name)
      .where('revoked_at', 'is', null)
      .returning('id')
      .executeTakeFirst()
    if (!row) fail('DR201', { kind: 'machine', key: name })
    sessions.close(row.id, CLOSE_REVOKED)
    return { name }
  })
}

/** Marks the machine seen at Hello and returns the last event seq applied for it; null once it is revoked. */
export function recordHello(ctx: TenantCtx, machineId: string, version: string): Promise<bigint | null> {
  return run(ctx, async (trx) => {
    const row = await trx
      .updateTable('machines')
      .set({ executor_version: version, last_seen_at: sql<Date>`now()` })
      .where('id', '=', machineId)
      .where('revoked_at', 'is', null)
      .returning('last_seq')
      .executeTakeFirst()
    return row ? BigInt(row.last_seq) : null
  })
}

/** Keeps the latest MachineReport; `machines.last_seen_at` moves with it. */
export function recordReport(ctx: TenantCtx, machineId: string, report: MachineReport): Promise<void> {
  return run(ctx, async (trx) => {
    await trx
      .updateTable('machines')
      .set({ last_report: JSON.stringify(report), last_seen_at: sql<Date>`now()` })
      .where('id', '=', machineId)
      .where('revoked_at', 'is', null)
      .execute()
  })
}
