import type { Kysely } from 'kysely'
import type { Database } from '../db/schema.ts'
import type { MachineMemory, Sessions } from '../executor/gateway.ts'
import { claimedOffer } from '../runs/dispatch.ts'
import type { Telemetry } from '../telemetry/otel.ts'
import { withTenant } from '../tenancy/scope.ts'
import { claimRun, defaultReserve } from './claim.ts'
import { expireOffers } from './expiry.ts'
import { SCHEDULER_CHANNEL } from './notify.ts'
import { type Listener, listen } from './wake.ts'

// A machine whose last MachineReport is older than this may be gone or wedged; its free memory is not trusted.
const REPORT_FRESH_MS = 30_000
// Bounds one machine's share of a tick, so a deep queue cannot hold the tick (and the other tenants) for long; the
// next wake goes on where this one stopped.
const MAX_CLAIMS_PER_MACHINE = 64

export type SchedulerLog = {
  warn(data: object, message: string): void
  error(data: object, message: string): void
}

export type SchedulerOptions = {
  db: Kysely<Database>
  sessions: Sessions
  offerTimeoutS: number
  pollMs: number
  telemetry: Telemetry | null
  log: SchedulerLog
  // Tests move it to age the machines' reports.
  now?: () => number
}

type Placeable = { machineId: string; available: bigint; reserve: bigint; room: bigint }

/**
 * Places queued runs on connected machines. It wakes on a NOTIFY of `devrounds_scheduler` (enqueue, run end; the
 * payload is the tenant), on a poke from the gateway (HelloAck, MachineReport) and on the poll, which covers every
 * tenant with a live session and so also a LISTEN that is down. Ticks run one at a time; a wake during a tick runs
 * another right after it.
 */
export class Scheduler {
  readonly #o: SchedulerOptions
  readonly #now: () => number
  // Tenants woken since the last tick began; `#everyone` on the poll and on a direct tick().
  #woken = new Set<string>()
  #everyone = false
  #running: Promise<void> | undefined
  #poll: NodeJS.Timeout | undefined
  #listener: Listener | undefined
  #stopped = false

  constructor(o: SchedulerOptions) {
    this.#o = o
    this.#now = o.now ?? Date.now
  }

  /** LISTENs on `listenUrl` (one dedicated connection) and starts the poll. A LISTEN that cannot connect is logged
   * and retried; the poll covers it meanwhile. */
  async start(listenUrl: string): Promise<void> {
    // A shutdown that came first (a signal while serve was starting) wins.
    if (this.#stopped) return
    this.#poll = setInterval(() => {
      this.#everyone = true
      this.#wake()
    }, this.#o.pollMs)
    this.#listener = listen(
      listenUrl,
      SCHEDULER_CHANNEL,
      (tenantId) => this.poke(tenantId),
      this.#o.log,
      () => {
        // NOTIFYs sent while the connection was down are lost; look at everyone once it is back.
        this.#everyone = true
        this.#wake()
      },
    )
    await this.#listener.ready
  }

  poke(tenantId: string): void {
    this.#woken.add(tenantId)
    this.#wake()
  }

  /** One pass over every tenant with a live session; resolves once no tick is running. */
  tick(): Promise<void> {
    this.#everyone = true
    this.#wake()
    return this.#idle()
  }

  async stop(): Promise<void> {
    this.#stopped = true
    clearInterval(this.#poll)
    await this.#listener?.close()
    await this.#idle()
  }

  // Resolves once no loop runs, including one restarted for a wake that came as the previous one ended.
  async #idle(): Promise<void> {
    while (this.#running) await this.#running
  }

  #wake(): void {
    if (this.#stopped) return
    // A running loop picks this wake up at its next check.
    this.#running ??= this.#loop().finally(() => {
      this.#running = undefined
      // A wake after the loop's last check, before this ran, found #running still set and started nothing; it is
      // still pending, so start the loop for it here.
      if (!this.#stopped && (this.#everyone || this.#woken.size > 0)) this.#wake()
    })
  }

  async #loop(): Promise<void> {
    while (!this.#stopped && (this.#everyone || this.#woken.size > 0)) {
      const tenants = this.#everyone
        ? new Set([...this.#woken, ...this.#o.sessions.list().map((s) => s.tenantId)])
        : new Set(this.#woken)
      this.#everyone = false
      this.#woken.clear()
      // First, so the machine of a withdrawn offer gets no new offer from this pass; each requeue's NOTIFY wakes its
      // tenant for the next one.
      try {
        await expireOffers(this.#o.db, this.#o.sessions, this.#o.offerTimeoutS, this.#o.log)
      } catch (err) {
        this.#o.log.error({ err }, 'offer expiry failed')
      }
      for (const tenantId of tenants) {
        try {
          await this.#placeTenant(tenantId)
        } catch (err) {
          // The database, usually; the next wake or poll tries again.
          this.#o.log.error({ err, tenantId }, 'scheduler tick failed')
        }
      }
    }
  }

  // Machines of the tenant with a recent report, most room first: free minus reserve minus the needs already offered.
  async #placeable(tenantId: string): Promise<Placeable[]> {
    const now = this.#now()
    const live = this.#o.sessions
      .list()
      .filter((s) => s.tenantId === tenantId && s.report !== undefined && now - s.report.at <= REPORT_FRESH_MS)
    if (live.length === 0) return []
    const inFlight = await withTenant(this.#o.db, tenantId, (trx) =>
      trx
        .selectFrom('runs')
        .select(['machine_id', (eb) => eb.fn.sum<string | null>('memory_need').as('need')])
        .where(
          'machine_id',
          'in',
          live.map((s) => s.machineId),
        )
        .where('state', 'in', ['offered', 'admitted'])
        .groupBy('machine_id')
        .execute(),
    )
    const placeable = live.map((s) => {
      const report = s.report as MachineMemory
      const reserve = defaultReserve(report.totalMemory)
      // Null for runs offered before claims stored their need; those count as nothing here.
      const need = BigInt(inFlight.find((row) => row.machine_id === s.machineId)?.need ?? 0)
      return {
        machineId: s.machineId,
        available: report.availableMemory,
        reserve,
        room: report.availableMemory - reserve - need,
      }
    })
    return placeable.sort((a, b) => (a.room > b.room ? -1 : a.room < b.room ? 1 : 0))
  }

  async #placeTenant(tenantId: string): Promise<void> {
    const { db, sessions, offerTimeoutS, telemetry } = this.#o
    for (const machine of await this.#placeable(tenantId)) {
      for (let i = 0; i < MAX_CLAIMS_PER_MACHINE && !this.#stopped; i++) {
        const offer = await withTenant(db, tenantId, async (trx) => {
          const claim = await claimRun(trx, machine.machineId, {
            freeBytes: machine.available,
            reserveBytes: machine.reserve,
            offerTimeoutS,
          })
          return claim && claimedOffer(trx, claim.runId, claim.memoryNeed, telemetry)
        })
        if (!offer) break
        // After the commit: the executor answers at once, and its events find no run until the claim commits. A
        // send that fails (the session dropped) leaves the run offered; the next HelloAck sends it again
        // (pendingOffers), and claiming more for a gone session would only pile up offers.
        if (!sessions.send(machine.machineId, offer)) break
      }
    }
  }
}
