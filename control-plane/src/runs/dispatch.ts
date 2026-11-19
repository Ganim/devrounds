import { EventEmitter } from 'node:events'
import { sql } from 'kysely'
import { fail } from '../errors/error.ts'
import type { Sessions } from '../executor/gateway.ts'
import type { ControlPlaneMessage } from '../executor/protocol.ts'
import { settledRuns, settleJob } from '../jobs/outcome.ts'
import { run, type TenantCtx, type Trx } from '../planning/resolve.ts'
import { parseTraceParent, type Telemetry } from '../telemetry/otel.ts'
import { learnedNeed } from './learned-need.ts'
import { failRevokedRuns, runTraceParent } from './record.ts'
import { nextRunState, TERMINAL } from './states.ts'
import { loadRunView, type RunView, requireRunId, runView } from './view.ts'

/** Emits `'changed'` with the run id after the gateway applied an event of that run. */
export const runEvents = new EventEmitter()
// One listener per `GET /runs/:id?wait` in flight; Node's default of 10 would warn under normal load.
runEvents.setMaxListeners(0)

type Offer = Extract<ControlPlaneMessage, { type: 'Offer' }>

// What an Offer of a run carries, from its run, job and job type.
function offerRows(trx: Trx) {
  return trx
    .selectFrom('runs')
    .innerJoin('jobs', 'jobs.id', 'runs.job_id')
    .innerJoin('job_types', 'job_types.id', 'runs.job_type_id')
    .select([
      'runs.id',
      'runs.project_id',
      'runs.memory_need',
      'runs.trace_id',
      'runs.trace_span_id',
      'jobs.cwd',
      'job_types.id as job_type_id',
      'job_types.key',
      'job_types.program',
      'job_types.args',
      'job_types.env_allow',
      'job_types.timeout_s',
    ])
}

type OfferRow = Awaited<ReturnType<ReturnType<typeof offerRows>['executeTakeFirstOrThrow']>>

function offerOf(row: OfferRow, memoryNeed: bigint, traceParent: string | null): Offer {
  return {
    type: 'Offer',
    run: row.id,
    job: {
      job_type: row.key,
      program: row.program,
      args: row.args as string[],
      cwd: row.cwd,
      env_allow: row.env_allow,
      timeout_s: row.timeout_s,
    },
    // A need is a byte count well under 2^53, so the wire carries it as a JSON number.
    memory_need: Number(memoryNeed),
    trace_parent: traceParent,
  }
}

/**
 * The Offer of a run the scheduler just claimed (scheduler/claim.ts), inside the claim's transaction, with the
 * memory need the claim reserved. With telemetry on, the run.dispatch span is exported here and its trace and span
 * ids go on the run, for a re-sent Offer and for run.record. The span is exported before the commit, so a rollback
 * leaves a span of a claim that did not happen; accepted, the trace id must go in this row.
 */
export async function claimedOffer(
  trx: Trx,
  runId: string,
  memoryNeed: bigint,
  telemetry: Telemetry | null,
): Promise<Offer> {
  const row = await offerRows(trx).where('runs.id', '=', runId).executeTakeFirstOrThrow()
  const traceParent = telemetry?.runDispatched({ id: runId, jobType: row.key }) ?? null
  const trace = parseTraceParent(traceParent)
  if (trace) {
    await trx
      .updateTable('runs')
      .set({ trace_id: trace.traceId, trace_span_id: trace.spanId })
      .where('id', '=', runId)
      .execute()
  }
  return offerOf(row, memoryNeed, traceParent)
}

/**
 * The Offer of every run of `machineId` still offered, oldest first, for the gateway to send again after each
 * HelloAck: an Offer lost with a session that dropped between the claim's commit and the send would leave its run
 * offered for good. The executor ignores the Offer of a run it already knows.
 *
 * This is the derived outbox: there is no outbox table. Every control plane to executor command (Offer, Withdraw via
 * the HelloAck's `withdrawn`, orphan Stop) is a function of committed state, so the send after a commit may be lost
 * and is recomputed from the rows after each HelloAck. An offer that expired is requeued and its run no longer
 * qualifies here; a delivered one is deduplicated by the executor, so re-sending is harmless.
 */
export function pendingOffers(ctx: TenantCtx, machineId: string): Promise<Offer[]> {
  return run(ctx, async (trx) => {
    const rows = await offerRows(trx)
      .where('runs.machine_id', '=', machineId)
      .where('runs.state', '=', 'offered')
      .orderBy('runs.offered_at')
      .execute()
    const offers: Offer[] = []
    for (const row of rows) {
      // A claim stores the need it reserved; a run offered before claims existed has none, so it gets the learned one.
      const need =
        row.memory_need === null
          ? await learnedNeed(trx, row.project_id, row.job_type_id, machineId)
          : BigInt(row.memory_need)
      offers.push(offerOf(row, need, runTraceParent(row)))
    }
    return offers
  })
}

/**
 * The runs of `machineId` withdrawn in the last 7 days, oldest first, for HelloAck.withdrawn: the executor drops the
 * ones it still holds, so a withdrawn offer it answers late never runs. 7 days is the executor's RUN_DIR_RETENTION,
 * the longest it keeps any trace of a run.
 */
export function recentlyWithdrawn(ctx: TenantCtx, machineId: string): Promise<string[]> {
  return run(ctx, async (trx) => {
    const rows = await trx
      .selectFrom('runs')
      .select('id')
      .where('machine_id', '=', machineId)
      .where('withdrawn_at', '>', sql<Date>`now() - interval '7 days'`)
      .orderBy('withdrawn_at')
      .execute()
    return rows.map((row) => row.id)
  })
}

export const QUEUED_STOP_SUMMARY = 'stopped while queued; no machine ran it'
export const OFFLINE_OFFER_STOP_SUMMARY = 'stopped while offered to an offline machine; withdrawn before it ran'

/** `changed`: every run the stop changed, the stopped one first, for the caller to wake their waiters. */
export type PreparedStop =
  | { view: RunView; ended: true; changed: string[] }
  | { view: RunView; ended: false; machineId: string; machine: string }

/**
 * Checks a stop is possible and returns the Stop to send; nothing changes until the executor reports the end. A run
 * still queued is on no executor: it stops here at once, class cancelled, and its job is settled (`ended`). An offered
 * run on a machine with no live session stops the same way and is withdrawn: its executor drops it at the next
 * HelloAck, so it never runs, and an answer that arrives before that is refused like any to an ended run. On a
 * revoked machine, whose executor never reports again, the run fails with class infra here instead (`ended`). An
 * admitted or running run on an offline machine answers DR350: its process may be alive, only its executor can stop
 * it. An ended run has no Stop to send.
 */
export async function prepareStop(
  ctx: TenantCtx,
  sessions: Sessions,
  runId: string,
  projectKey?: string,
): Promise<PreparedStop> {
  requireRunId(runId)
  return run(ctx, async (trx) => {
    await loadRunView(trx, runId, projectKey)
    // Locked before the state is read, so a claim (which skips locked rows) or an executor event cannot move the run
    // while it is being stopped.
    const { state } = await trx
      .selectFrom('runs')
      .select('state')
      .where('id', '=', runId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow()
    if (TERMINAL.includes(state)) fail('DR351', { run: runId, state })
    const cancel = async (summary: string, withdraw: boolean) => {
      const next = nextRunState(state, 'stop', runId)
      await trx
        .updateTable('runs')
        .set({
          state: next.state,
          finished_at: sql<Date>`greatest(now(), offered_at)`,
          failure_class: 'cancelled',
          failure_summary: summary,
          ...(withdraw ? { withdrawn_at: sql<Date>`now()` } : {}),
        })
        .where('id', '=', runId)
        .execute()
      const changed = [runId, ...settledRuns(await settleJob(trx, ctx.tenantId, runId))]
      return { view: await loadRunView(trx, runId), ended: true as const, changed }
    }
    if (state === 'queued') return cancel(QUEUED_STOP_SUMMARY, false)
    // Past queued, a claim has placed the run on a machine.
    const row = await trx
      .selectFrom('runs')
      .innerJoin('machines', 'machines.id', 'runs.machine_id')
      .select(['machines.id', 'machines.name', 'machines.revoked_at'])
      .where('runs.id', '=', runId)
      .executeTakeFirstOrThrow()
    if (row.revoked_at !== null) {
      const changed = await failRevokedRuns(trx, row, runId)
      return { view: await loadRunView(trx, runId), ended: true, changed }
    }
    if (!sessions.get(row.id)) {
      if (state === 'offered') return cancel(OFFLINE_OFFER_STOP_SUMMARY, true)
      fail('DR350', { machine: row.name })
    }
    return { view: await loadRunView(trx, runId), machineId: row.id, machine: row.name, ended: false }
  })
}

/**
 * Asks the run's executor to stop it (Stop cancel). A run that ended answers DR351, a run past offered on an offline
 * machine DR350; a queued run or an offer to an offline machine stops and a run on a revoked machine fails at once
 * (see prepareStop).
 */
export async function stopRun(
  ctx: TenantCtx,
  sessions: Sessions,
  runId: string,
  projectKey?: string,
): Promise<RunView> {
  const stop = await prepareStop(ctx, sessions, runId, projectKey)
  if (stop.ended) {
    for (const changed of stop.changed) runEvents.emit('changed', changed)
    return stop.view
  }
  if (!sessions.send(stop.machineId, { type: 'Stop', run: runId, reason: 'cancel' })) {
    fail('DR350', { machine: stop.machine })
  }
  return stop.view
}

/**
 * The run once it is terminal, or as it is after `waitS` seconds. An aborted `signal` (the client went away) ends the
 * wait early with the run as it is.
 */
export async function waitForRun(
  ctx: TenantCtx,
  runId: string,
  waitS: number,
  opts: { projectKey?: string; signal?: AbortSignal } = {},
): Promise<RunView> {
  requireRunId(runId)
  const { projectKey, signal } = opts
  const deadline = Date.now() + waitS * 1000
  let wake: (() => void) | undefined
  let dirty = false
  const listener = (changed: string) => {
    if (changed !== runId) return
    dirty = true
    wake?.()
  }
  const abort = () => wake?.()
  // Subscribed before the first read, so an event applied between a read and the wait is not missed.
  runEvents.on('changed', listener)
  signal?.addEventListener('abort', abort)
  try {
    for (;;) {
      dirty = false
      const view = await runView(ctx, runId, projectKey)
      const left = deadline - Date.now()
      if (TERMINAL.includes(view.state) || left <= 0 || signal?.aborted) return view
      if (dirty) continue
      let timer: NodeJS.Timeout | undefined
      await new Promise<void>((resolve) => {
        wake = resolve
        timer = setTimeout(resolve, left)
      })
      clearTimeout(timer)
      wake = undefined
    }
  } finally {
    runEvents.off('changed', listener)
    signal?.removeEventListener('abort', abort)
  }
}
