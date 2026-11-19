import { EventEmitter } from 'node:events'
import type { Selectable } from 'kysely'
import type { JobTypesTable } from '../db/schema.ts'
import { fail } from '../errors/error.ts'
import type { Sessions } from '../executor/gateway.ts'
import type { ControlPlaneMessage } from '../executor/protocol.ts'
import { findJobType } from '../job-types/service.ts'
import { type Ctx, findProject, run, type TenantCtx, type Trx } from '../planning/resolve.ts'
import type { Telemetry } from '../telemetry/otel.ts'
import { learnedNeed } from './learned-need.ts'
import { createRun, failRevokedRuns, markOffered, runTraceParent } from './record.ts'
import { TERMINAL } from './states.ts'
import { loadRunView, type RunView, requireRunId, runView } from './view.ts'

/** Emits `'changed'` with the run id after the gateway applied an event of that run. */
export const runEvents = new EventEmitter()
// One listener per `GET /runs/:id?wait` in flight; Node's default of 10 would warn under normal load.
runEvents.setMaxListeners(0)

export type DispatchInput = {
  projectKey: string
  jobTypeKey: string
  machineName: string
  cwd: string
  taskKey?: string
}

type Offer = Extract<ControlPlaneMessage, { type: 'Offer' }>

/** The machine's id when it has a live session; DR350 otherwise, DR201 when no live machine has that name. */
async function connectedMachine(ctx: TenantCtx, sessions: Sessions, name: string): Promise<string> {
  const machine = await run(ctx, (trx) =>
    trx.selectFrom('machines').select('id').where('name', '=', name).where('revoked_at', 'is', null).executeTakeFirst(),
  )
  if (!machine) fail('DR201', { kind: 'machine', key: name })
  if (!sessions.get(machine.id)) fail('DR350', { machine: name })
  return machine.id
}

/**
 * Records a run as offered and builds its Offer, inside the caller's transaction when `ctx.trx` is set. The Offer is
 * not sent here: the executor answers it at once, and its events find no run (DR201) until this transaction commits.
 */
export async function recordDispatch(
  ctx: Ctx,
  sessions: Sessions,
  i: DispatchInput,
  telemetry: Telemetry | null = null,
): Promise<{ view: RunView; machineId: string; offer: Offer }> {
  const machineId = await connectedMachine(ctx, sessions, i.machineName)
  return run(ctx, async (trx) => {
    const inner = { ...ctx, trx }
    const created = await createRun(inner, i)
    // Exported before the commit, so a rollback after this point leaves a run.dispatch span of a run that does not
    // exist; accepted (the live machine and the job type are already checked), the trace id must go in this row.
    const traceParent = telemetry?.runDispatched({ id: created.id, jobType: i.jobTypeKey }) ?? null
    await markOffered(inner, created.id, traceParent)
    const project = await findProject(trx, i.projectKey)
    const jobType = await findJobType(trx, project.id, i.jobTypeKey)
    const offered = { id: created.id, project_id: project.id, cwd: i.cwd, machine_id: machineId, traceParent }
    const offer = await offerOf(trx, offered, jobType)
    return { view: await loadRunView(trx, created.id), machineId, offer }
  })
}

type JobTypeRow = Pick<Selectable<JobTypesTable>, 'id' | 'key' | 'program' | 'args' | 'env_allow' | 'timeout_s'>

async function offerOf(
  trx: Trx,
  run: { id: string; project_id: string; cwd: string; machine_id: string; traceParent: string | null },
  jobType: JobTypeRow,
): Promise<Offer> {
  const need = await learnedNeed(trx, run.project_id, jobType.id, run.machine_id)
  return {
    type: 'Offer',
    run: run.id,
    job: {
      job_type: jobType.key,
      program: jobType.program,
      args: jobType.args as string[],
      cwd: run.cwd,
      env_allow: jobType.env_allow,
      timeout_s: jobType.timeout_s,
    },
    // A learned peak is a byte count well under 2^53, so the wire carries it as a JSON number.
    memory_need: Number(need),
    trace_parent: run.traceParent,
  }
}

/**
 * The Offer of every run of `machineId` still offered, oldest first, for the gateway to send again after each
 * HelloAck: an Offer lost with a session that dropped after the dispatch commit would leave its run offered for
 * good. The executor ignores the Offer of a run it already knows.
 */
export function pendingOffers(ctx: TenantCtx, machineId: string): Promise<Offer[]> {
  return run(ctx, async (trx) => {
    const rows = await trx
      .selectFrom('runs')
      .innerJoin('jobs', 'jobs.id', 'runs.job_id')
      .innerJoin('job_types', 'job_types.id', 'runs.job_type_id')
      .select([
        'runs.id',
        'runs.project_id',
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
      .where('runs.machine_id', '=', machineId)
      .where('runs.state', '=', 'offered')
      .orderBy('runs.offered_at')
      .execute()
    const offers: Offer[] = []
    for (const row of rows) {
      offers.push(
        await offerOf(
          trx,
          { ...row, machine_id: machineId, traceParent: runTraceParent(row) },
          { ...row, id: row.job_type_id },
        ),
      )
    }
    return offers
  })
}

/**
 * Creates a run on a connected machine and offers it. `ctx` must not carry a transaction: the Offer goes out after
 * the commit. A session lost between the commit and the send leaves the run offered.
 */
export async function dispatchRun(
  ctx: Ctx,
  sessions: Sessions,
  i: DispatchInput,
  telemetry: Telemetry | null = null,
): Promise<RunView> {
  const { view, machineId, offer } = await recordDispatch(ctx, sessions, i, telemetry)
  sessions.send(machineId, offer)
  return view
}

/**
 * Checks a stop is possible and returns the Stop to send; nothing changes until the executor reports the end. On a
 * revoked machine, whose executor never reports again, the run fails with class infra here instead (`ended`), and no
 * Stop is to be sent.
 */
export async function prepareStop(
  ctx: TenantCtx,
  sessions: Sessions,
  runId: string,
  projectKey?: string,
): Promise<{ view: RunView; machineId: string; machine: string; ended: boolean }> {
  requireRunId(runId)
  return run(ctx, async (trx) => {
    const view = await loadRunView(trx, runId, projectKey)
    if (TERMINAL.includes(view.state)) fail('DR351', { run: runId, state: view.state })
    const row = await trx
      .selectFrom('runs')
      .innerJoin('machines', 'machines.id', 'runs.machine_id')
      .select(['machines.id', 'machines.name', 'machines.revoked_at'])
      .where('runs.id', '=', runId)
      .executeTakeFirst()
    // Only a run queued through jobs/enqueue.ts has no machine yet; no executor knows it, so there is nothing to
    // stop until stopping a queued run is a state change of its own (P1-T45).
    if (!row) fail('DR351', { run: runId, state: view.state })
    if (row.revoked_at !== null) {
      const failed = await failRevokedRuns(trx, row, runId)
      // Ended meanwhile (an event applied since the read): its state is the answer, as for any ended run.
      if (failed.length === 0) fail('DR351', { run: runId, state: (await loadRunView(trx, runId)).state })
      return { view: await loadRunView(trx, runId), machineId: row.id, machine: row.name, ended: true }
    }
    if (!sessions.get(row.id)) fail('DR350', { machine: row.name })
    return { view, machineId: row.id, machine: row.name, ended: false }
  })
}

/**
 * Asks the run's executor to stop it (Stop cancel). A run that ended answers DR351, an offline machine DR350; on a
 * revoked machine the run fails at once (see prepareStop).
 */
export async function stopRun(
  ctx: TenantCtx,
  sessions: Sessions,
  runId: string,
  projectKey?: string,
): Promise<RunView> {
  const { view, machineId, machine, ended } = await prepareStop(ctx, sessions, runId, projectKey)
  if (ended) {
    runEvents.emit('changed', runId)
    return view
  }
  if (!sessions.send(machineId, { type: 'Stop', run: runId, reason: 'cancel' })) {
    fail('DR350', { machine })
  }
  return view
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
