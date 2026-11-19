import { sql } from 'kysely'
import { fail } from '../errors/error.ts'
import type { MachineReport } from '../executor/protocol.ts'
import { type Ctx, run, type TenantCtx } from '../planning/resolve.ts'
import { failRevokedRuns } from '../runs/record.ts'
import { defaultReserve } from '../scheduler/claim.ts'
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
  // From the latest MachineReport; null until the machine sent one. Same figures the scheduler places by.
  freeBytes: number | null
  // Needs of the runs offered or admitted on it, which the scheduler keeps off its free memory.
  reservedBytes: number
  // Kept free on it: min(total / 10, 2 GiB).
  reserveBytes: number | null
  // last_seen_at moves with every report and with Hello, and the executor reports right after Hello and then every
  // 10 s, so it dates the report to within one interval.
  reportAt: Date | null
}

type StoredReport = Pick<MachineReport, 'total_memory' | 'available_memory'>

/** Live (not revoked) machines of the tenant, by name. */
export function listMachines(ctx: TenantCtx): Promise<MachineView[]> {
  return run(ctx, async (trx) => {
    const inFlight = await trx
      .selectFrom('runs')
      .select(['machine_id', (eb) => eb.fn.sum<string | null>('memory_need').as('need')])
      .where('machine_id', 'is not', null)
      .where('state', 'in', ['offered', 'admitted'])
      .groupBy('machine_id')
      .execute()
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
    return rows.map((row) => {
      const report = row.last_report as StoredReport | null
      // Byte counts fit a JS number: the protocol refuses any past 2^53 (executor/protocol.ts).
      const need = inFlight.find((r) => r.machine_id === row.id)?.need
      return {
        id: row.id,
        name: row.name,
        os: row.os,
        executorVersion: row.executor_version,
        computeProvider: row.compute_provider,
        lifecycle: row.lifecycle,
        pairedAt: row.paired_at,
        lastSeenAt: row.last_seen_at,
        lastReport: row.last_report,
        freeBytes: report ? report.available_memory : null,
        reservedBytes: Number(need ?? 0),
        reserveBytes: report ? Number(defaultReserve(BigInt(report.total_memory))) : null,
        reportAt: report ? row.last_seen_at : null,
      }
    })
  })
}

/**
 * Revokes the live machine `name` and returns its id, with the runs it had not ended, now ended with class infra in
 * the same transaction (and every run that changed with them, see failRevokedRuns): a revoked executor never
 * reports again, so they would stay offered or running for good, and no claim takes a run pinned to it.
 * Its session is not closed here: the caller closes it with closeRevoked once the transaction has committed, because
 * 4401 makes the executor stop for good and a rolled-back revoke would leave it stopped with a valid token. A session
 * that starts before the commit still ends, because recordHello's update waits on this row lock and then finds the
 * machine revoked.
 */
export async function revokeMachine(
  ctx: Ctx,
  name: string,
): Promise<{ name: string; machineId: string; changedRuns: string[] }> {
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
    return { name, machineId: row.id, changedRuns: await failRevokedRuns(trx, { id: row.id, name }) }
  })
}

/**
 * Ends the live session of a machine whose revocation has committed. `sessions` is the gateway's Sessions, typed by
 * shape: the web view imports MachineView from this file, and importing the gateway would pull Fastify's websocket
 * types into the web type check.
 */
export function closeRevoked(sessions: { close(machineId: string, code: number): void }, machineId: string): void {
  sessions.close(machineId, CLOSE_REVOKED)
}

/**
 * Marks the machine seen at Hello and returns the last event seq applied for it; null once it is revoked. With
 * `ackedThrough` (Hello.acked_through) above last_seq, last_seq moves up to it and `raisedFrom` names the old value:
 * the executor holds no event up to that seq any more, so waiting for them would wedge the machine. That happens when
 * a home is paired again as a new machine (last_seq 0, the executor's seqs go on) or the database was restored.
 */
export function recordHello(
  ctx: TenantCtx,
  machineId: string,
  version: string,
  ackedThrough?: number,
): Promise<{ lastSeq: bigint; raisedFrom: bigint | null } | null> {
  return run(ctx, async (trx) => {
    const row = await trx
      .updateTable('machines')
      .set({ executor_version: version, last_seen_at: sql<Date>`now()` })
      .where('id', '=', machineId)
      .where('revoked_at', 'is', null)
      .returning('last_seq')
      .executeTakeFirst()
    if (!row) return null
    const lastSeq = BigInt(row.last_seq)
    if (ackedThrough === undefined || BigInt(ackedThrough) <= lastSeq) return { lastSeq, raisedFrom: null }
    await trx
      .updateTable('machines')
      .set({ last_seq: String(ackedThrough) })
      .where('id', '=', machineId)
      .execute()
    return { lastSeq: BigInt(ackedThrough), raisedFrom: lastSeq }
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
