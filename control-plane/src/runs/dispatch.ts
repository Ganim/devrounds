import { EventEmitter } from 'node:events'
import { fail } from '../errors/error.ts'
import type { Sessions } from '../executor/gateway.ts'
import type { ControlPlaneMessage } from '../executor/protocol.ts'
import { findJobType } from '../job-types/service.ts'
import { type Ctx, findProject, run, type TenantCtx } from '../planning/resolve.ts'
import { learnedNeed } from './learned-need.ts'
import { createRun, markOffered } from './record.ts'
import { TERMINAL } from './states.ts'
import { loadRunView, type RunView, requireRunId, runView } from './view.ts'

/** Emits `'changed'` with the run id after the gateway applied an event of that run. */
export const runEvents = new EventEmitter()
// One listener per `GET /runs/:id?wait` in flight; Node's default of 10 would warn under normal load.
runEvents.setMaxListeners(0)

export type DispatchInput = { projectKey: string; jobTypeKey: string; machineName: string; cwd: string; taskKey?: string }

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
): Promise<{ view: RunView; machineId: string; offer: Offer }> {
  const machineId = await connectedMachine(ctx, sessions, i.machineName)
  return run(ctx, async (trx) => {
    const inner = { ...ctx, trx }
    const created = await createRun(inner, i)
    await markOffered(inner, created.id)
    const project = await findProject(trx, i.projectKey)
    const jobType = await findJobType(trx, project.id, i.jobTypeKey)
    const need = await learnedNeed(trx, project.id, jobType.id, machineId)
    const offer: Offer = {
      type: 'Offer',
      run: created.id,
      job: {
        job_type: jobType.key,
        program: jobType.program,
        args: jobType.args as string[],
        cwd: i.cwd,
        env_allow: jobType.env_allow,
        timeout_s: jobType.timeout_s,
      },
      // A learned peak is a byte count well under 2^53, so the wire carries it as a JSON number.
      memory_need: Number(need),
      trace_parent: null,
    }
    return { view: await loadRunView(trx, created.id), machineId, offer }
  })
}

/**
 * Creates a run on a connected machine and offers it. `ctx` must not carry a transaction: the Offer goes out after
 * the commit. A session lost between the commit and the send leaves the run offered.
 */
export async function dispatchRun(ctx: Ctx, sessions: Sessions, i: DispatchInput): Promise<RunView> {
  const { view, machineId, offer } = await recordDispatch(ctx, sessions, i)
  sessions.send(machineId, offer)
  return view
}

/** Checks a stop is possible and returns the Stop to send; nothing changes until the executor reports the end. */
export async function prepareStop(
  ctx: TenantCtx,
  sessions: Sessions,
  runId: string,
): Promise<{ view: RunView; machineId: string }> {
  requireRunId(runId)
  return run(ctx, async (trx) => {
    const view = await loadRunView(trx, runId)
    if (TERMINAL.includes(view.state)) fail('DR351', { run: runId, state: view.state })
    const row = await trx.selectFrom('runs').select('machine_id').where('id', '=', runId).executeTakeFirstOrThrow()
    if (!sessions.get(row.machine_id)) fail('DR350', { machine: view.machine })
    return { view, machineId: row.machine_id }
  })
}

/** Asks the run's executor to stop it (Stop cancel). A run that ended answers DR351, an offline machine DR350. */
export async function stopRun(ctx: TenantCtx, sessions: Sessions, runId: string): Promise<RunView> {
  const { view, machineId } = await prepareStop(ctx, sessions, runId)
  if (!sessions.send(machineId, { type: 'Stop', run: runId, reason: 'cancel' })) {
    fail('DR350', { machine: view.machine })
  }
  return view
}

/** The run once it is terminal, or as it is after `waitS` seconds. */
export async function waitForRun(ctx: TenantCtx, runId: string, waitS: number): Promise<RunView> {
  requireRunId(runId)
  const deadline = Date.now() + waitS * 1000
  let wake: (() => void) | undefined
  let dirty = false
  const listener = (changed: string) => {
    if (changed !== runId) return
    dirty = true
    wake?.()
  }
  // Subscribed before the first read, so an event applied between a read and the wait is not missed.
  runEvents.on('changed', listener)
  try {
    for (;;) {
      dirty = false
      const view = await runView(ctx, runId)
      const left = deadline - Date.now()
      if (TERMINAL.includes(view.state) || left <= 0) return view
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
  }
}
