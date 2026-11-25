import { sql } from 'kysely'
import type { MachineMemory, Sessions } from '../executor/gateway.ts'
import { run, type TenantCtx, type Trx } from '../planning/resolve.ts'
import { storedNeed } from '../runs/learned-need.ts'
import { defaultReserve } from './claim.ts'

// A machine whose last MachineReport is older than this may be gone or wedged; its free memory is not trusted.
const REPORT_FRESH_MS = 30_000

export type Placeable = { machineId: string; available: bigint; reserve: bigint; runningUsed: bigint; room: bigint }

/**
 * Memory the machine's running runs already hold, so already missing from its free memory: what it used since its
 * last report with no run, 0 before this session saw one. The report has no per-run figure; this one also counts any
 * other program's growth since (running runs then count less, as before F-0012) and nothing that started before the
 * idle report (they count whole). claim_run subtracts it from the running runs' needs, never below 0.
 */
export function runningUsed(report: MachineMemory): bigint {
  const used = report.idleAvailable === undefined ? 0n : report.idleAvailable - report.availableMemory
  return used > 0n ? used : 0n
}

/**
 * Machines of the tenant the scheduler offers to, most room first: a session with a recent report, room = free minus
 * reserve minus claim_run's in-flight sum: the needs offered or admitted there plus what its running runs may still
 * claim (their needs minus runningUsed, at least 0). An executor without job-env would drop the Offer's env_set and
 * run the job without its values, so it is not placeable.
 */
export async function placeable(trx: Trx, sessions: Sessions, tenantId: string, now: number): Promise<Placeable[]> {
  const live = sessions
    .list()
    .filter(
      (s) =>
        s.tenantId === tenantId &&
        s.features.includes('job-env') &&
        s.report !== undefined &&
        now - s.report.at <= REPORT_FRESH_MS,
    )
  if (live.length === 0) return []
  const inFlight = await trx
    .selectFrom('runs')
    .select([
      'machine_id',
      sql<string | null>`sum(memory_need) filter (where state <> 'running')`.as('need'),
      sql<string | null>`sum(memory_need) filter (where state = 'running')`.as('running_need'),
    ])
    .where(
      'machine_id',
      'in',
      live.map((s) => s.machineId),
    )
    .where('state', 'in', ['offered', 'admitted', 'running'])
    .groupBy('machine_id')
    .execute()
  const machines = live.map((s) => {
    const report = s.report as MachineMemory
    const reserve = defaultReserve(report.totalMemory)
    // Null for runs offered before claims stored their need; those count as nothing here, as in claim_run.
    const row = inFlight.find((r) => r.machine_id === s.machineId)
    const used = runningUsed(report)
    const ahead = BigInt(row?.running_need ?? 0) - used
    const need = BigInt(row?.need ?? 0) + (ahead > 0n ? ahead : 0n)
    return {
      machineId: s.machineId,
      available: report.availableMemory,
      reserve,
      runningUsed: used,
      room: report.availableMemory - reserve - need,
    }
  })
  return machines.sort((a, b) => (a.room > b.room ? -1 : a.room < b.room ? 1 : 0))
}

// Byte counts are numbers in the API: a machine's memory is far below 2^53.
export type Unplaced =
  | { reason: 'no_machine' }
  | { reason: 'machine_offline'; machine: string }
  | { reason: 'memory'; machine: string; needBytes: number; freeBytes: number }

/**
 * Why each queued run of `runIds` has no machine able to take it, from the same inputs as placement: the placeable
 * machines above, the pin, and the need claim_run would use (storedNeed). A run that fits a placeable machine, or is
 * not queued, has no entry; it may still wait for its dependencies, a queue cap or its backoff, which are not a
 * machine's fault. With memory short everywhere it names the roomiest machine, with free clamped at 0.
 */
export async function unplacedReasons(
  ctx: TenantCtx,
  sessions: Sessions,
  runIds: string[],
  now = Date.now(),
): Promise<Map<string, Unplaced>> {
  const reasons = new Map<string, Unplaced>()
  if (runIds.length === 0) return reasons
  return run(ctx, async (trx) => {
    const rows = await trx
      .selectFrom('runs as r')
      .innerJoin('jobs as j', 'j.id', 'r.job_id')
      .leftJoin('machines as m', 'm.id', 'j.machine_id')
      .select(['r.id', 'r.project_id', 'r.job_type_id', 'j.machine_id as pin', 'm.name as pin_name'])
      .where('r.id', 'in', runIds)
      .where('r.state', '=', 'queued')
      .execute()
    if (rows.length === 0) return reasons
    const machines = await placeable(trx, sessions, ctx.tenantId, now)
    const names = new Map(
      machines.length === 0
        ? []
        : (
            await trx
              .selectFrom('machines')
              .select(['id', 'name'])
              .where(
                'id',
                'in',
                machines.map((m) => m.machineId),
              )
              .execute()
          ).map((m) => [m.id, m.name]),
    )
    for (const row of rows) {
      const candidates = row.pin === null ? machines : machines.filter((m) => m.machineId === row.pin)
      if (candidates.length === 0) {
        reasons.set(
          row.id,
          row.pin === null ? { reason: 'no_machine' } : { reason: 'machine_offline', machine: row.pin_name as string },
        )
        continue
      }
      // The need is per machine (learned_needs is keyed by it); candidates come most room first.
      let fits = false
      let roomiest: { machineId: string; need: bigint; room: bigint } | undefined
      for (const m of candidates) {
        const need = await storedNeed(trx, row.project_id, row.job_type_id, m.machineId)
        if (need <= m.room) {
          fits = true
          break
        }
        roomiest ??= { machineId: m.machineId, need, room: m.room }
      }
      if (!fits && roomiest) {
        reasons.set(row.id, {
          reason: 'memory',
          machine: names.get(roomiest.machineId) as string,
          needBytes: Number(roomiest.need),
          freeBytes: Number(roomiest.room > 0n ? roomiest.room : 0n),
        })
      }
    }
    return reasons
  })
}
