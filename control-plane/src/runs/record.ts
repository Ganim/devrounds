import { sql, type Updateable } from 'kysely'
import type { RunsTable } from '../db/schema.ts'
import { DevRoundsError, fail } from '../errors/error.ts'
import type { ControlPlaneMessage, RunEvent } from '../executor/protocol.ts'
import { findJobType } from '../job-types/service.ts'
import { type Ctx, findProject, findTask, run, type TenantCtx, type Trx } from '../planning/resolve.ts'
import { type ClassifyRule, classifyRun } from './classify.ts'
import { nextRunState, type RunTransition, TERMINAL } from './states.ts'
import { loadRunView, type RunView, requireRunId } from './view.ts'

const INT_MAX = 2147483647

/** Records a job and its first run, queued. The machine is the live machine named `machineName`. */
export function createRun(
  ctx: Ctx,
  i: { projectKey: string; jobTypeKey: string; machineName: string; cwd: string; taskKey?: string },
): Promise<RunView> {
  return run(ctx, async (trx) => {
    const project = await findProject(trx, i.projectKey)
    const jobType = await findJobType(trx, project.id, i.jobTypeKey)
    const machine = await trx
      .selectFrom('machines')
      .select('id')
      .where('name', '=', i.machineName)
      .where('revoked_at', 'is', null)
      .executeTakeFirst()
    if (!machine) fail('DR201', { kind: 'machine', key: i.machineName })
    const task = i.taskKey === undefined ? null : await findTask(trx, project.id, i.taskKey)
    const job = await trx
      .insertInto('jobs')
      .values({
        tenant_id: ctx.tenantId,
        project_id: project.id,
        job_type_id: jobType.id,
        task_id: task?.id ?? null,
        cwd: i.cwd,
        machine_id: machine.id,
        created_by: ctx.actor.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return insertRun(trx, ctx.tenantId, job.id, 1)
  })
}

/** A new run of the same job (same job type, machine, cwd and task), attempt + 1. Only an ended run is retried. */
export async function retryRun(ctx: Ctx, runId: string): Promise<RunView> {
  requireRunId(runId)
  return run(ctx, async (trx) => {
    const previous = await trx.selectFrom('runs').select(['job_id', 'state']).where('id', '=', runId).executeTakeFirst()
    if (!previous) fail('DR201', { kind: 'run', key: runId })
    if (!TERMINAL.includes(previous.state)) fail('DR351', { run: runId, state: previous.state })
    // Serializes retries of one job, so two at once cannot pick the same attempt number.
    await trx.selectFrom('jobs').select('id').where('id', '=', previous.job_id).forNoKeyUpdate().execute()
    const { last } = await trx
      .selectFrom('runs')
      .select((eb) => eb.fn.max('attempt').as('last'))
      .where('job_id', '=', previous.job_id)
      .executeTakeFirstOrThrow()
    return insertRun(trx, ctx.tenantId, previous.job_id, last + 1)
  })
}

async function insertRun(trx: Trx, tenantId: string, jobId: string, attempt: number): Promise<RunView> {
  const job = await trx
    .selectFrom('jobs')
    .select(['project_id', 'job_type_id', 'machine_id'])
    .where('id', '=', jobId)
    .executeTakeFirstOrThrow()
  const { id } = await trx
    .insertInto('runs')
    .values({ tenant_id: tenantId, job_id: jobId, attempt, ...job })
    .returning('id')
    .executeTakeFirstOrThrow()
  return loadRunView(trx, id)
}

/** queued → offered, stamped with the control plane clock when the Offer goes out. */
export async function markOffered(ctx: TenantCtx, runId: string): Promise<void> {
  requireRunId(runId)
  return run(ctx, async (trx) => {
    const row = await trx.selectFrom('runs').select('state').where('id', '=', runId).forNoKeyUpdate().executeTakeFirst()
    if (!row) fail('DR201', { kind: 'run', key: runId })
    const next = nextRunState(row.state, 'offer', runId)
    await trx
      .updateTable('runs')
      .set({ state: next.state, offered_at: sql<Date>`now()` })
      .where('id', '=', runId)
      .execute()
  })
}

type PatternLog = { warn(data: { jobType: string; rule: number }, message: string): void }

// Every stamp already on the run; greatest() skips nulls, so a run offered a moment ago answers offered_at.
async function latestStamp(trx: Trx, runId: string): Promise<Date | null> {
  const { rows } = await sql<{ latest: Date | null }>`
    select greatest(
      r.offered_at, r.admitted_at, r.started_at, r.finished_at,
      (select max(greatest(s.started_at, s.finished_at)) from run_steps s where s.run_id = r.id),
      (select max(d.at) from run_delays d where d.run_id = r.id)
    ) as latest
    from runs r where r.id = ${runId}`.execute(trx)
  return rows[0]?.latest ?? null
}

// The run of `machineId`, locked for its update; DR201 for a run of another machine, as for every executor event.
async function lockRun(trx: Trx, machineId: string, runId: string) {
  const row = await trx
    .selectFrom('runs')
    .select(['state', 'clock_skew_ms', 'job_type_id', 'orphan_action'])
    .where('id', '=', runId)
    .where('machine_id', '=', machineId)
    .forNoKeyUpdate()
    .executeTakeFirst()
  if (!row) fail('DR201', { kind: 'run', key: runId })
  return row
}

// The time to stamp for an executor event at `at` and the run's new clock_skew_ms (see applyRunEvent).
async function clamp(trx: Trx, runId: string, at: Date, skewMs: number) {
  const floor = await latestStamp(trx, runId)
  const behind = floor ? floor.getTime() - at.getTime() : 0
  const stamp = behind > 0 ? (floor as Date) : at
  return { stamp, clock_skew_ms: Math.min(INT_MAX, Math.max(skewMs, behind)) }
}

const END: Record<'finished' | 'failed' | 'stopped', RunTransition> = {
  finished: 'finish',
  failed: 'fail',
  stopped: 'stop',
}

/**
 * Applies one executor event of machine `machineId` to its run, in one transaction. `at` is the event's executor
 * timestamp. The executor clock may be behind the control plane's, or step back: a time earlier than the latest one
 * already on the run (offered_at, which the control plane stamped, or any later stamp, step or delay) is clamped to
 * it, and clock_skew_ms keeps the largest gap seen, so no duration is ever negative.
 * LogSegment and Orphans change nothing here: the gateway stores segments (log-store.ts) and applies Orphans with
 * applyOrphans.
 * `log` gets the one warning a classification that ran out of pattern budget writes.
 */
export async function applyRunEvent(
  ctx: TenantCtx,
  machineId: string,
  event: RunEvent,
  at: Date,
  log: PatternLog = { warn: (data, message) => process.emitWarning(`${message} ${JSON.stringify(data)}`) },
): Promise<void> {
  if (event.kind === 'LogSegment' || event.kind === 'Orphans') return
  requireRunId(event.run)
  const runId = event.run
  await run(ctx, async (trx) => {
    const row = await lockRun(trx, machineId, runId)
    const { stamp, clock_skew_ms } = await clamp(trx, runId, at, row.clock_skew_ms)
    const move = (transition: RunTransition): Updateable<RunsTable> => {
      const next = nextRunState(row.state, transition, runId)
      const set: Updateable<RunsTable> = { state: next.state, clock_skew_ms }
      if (next.stamp) set[next.stamp] = stamp
      return set
    }
    const update = (set: Updateable<RunsTable>) => trx.updateTable('runs').set(set).where('id', '=', runId).execute()
    const requireRunning = () => {
      if (row.state !== 'running') fail('DR351', { run: runId, state: row.state })
    }

    switch (event.kind) {
      case 'Admitted':
        await update(move('admit'))
        return
      case 'Delayed':
        await update(move('delay'))
        await trx
          .insertInto('run_delays')
          .values({
            tenant_id: ctx.tenantId,
            run_id: runId,
            at: stamp,
            reason: event.reason,
            need_bytes: event.need,
            available_bytes: event.available,
            position: event.position,
          })
          .execute()
        return
      case 'RunStarted':
        await update({
          ...move('start'),
          pid: event.pid,
          // FILETIME passes 2^53, so it stays a decimal string from the wire to the int8 column.
          process_start_time: BigInt(event.start_time).toString(),
          boot_id: event.boot_id,
        })
        return
      case 'StepStarted': {
        requireRunning()
        await update({ clock_skew_ms })
        const inserted = await trx
          .insertInto('run_steps')
          .values({ tenant_id: ctx.tenantId, run_id: runId, step: event.step, name: event.name, started_at: stamp })
          .onConflict((oc) => oc.columns(['run_id', 'step']).doNothing())
          .returning('id')
          .executeTakeFirst()
        // A step starts once; a repeat is an illegal change like any other, not a raw unique violation.
        if (!inserted) fail('DR351', { run: runId, state: row.state })
        return
      }
      case 'StepFinished': {
        requireRunning()
        await update({ clock_skew_ms })
        const step = await trx
          .updateTable('run_steps')
          .set({ finished_at: stamp, outcome: event.outcome })
          .where('run_id', '=', runId)
          .where('step', '=', event.step)
          .executeTakeFirst()
        if (step.numUpdatedRows === 0n) fail('DR201', { kind: 'step', key: `${runId}#${event.step}` })
        return
      }
      case 'RunFinished': {
        const jobType = await trx
          .selectFrom('job_types')
          .select(['key', 'classify'])
          .where('id', '=', row.job_type_id)
          .executeTakeFirstOrThrow()
        const result = await classifyRun(
          { reason: event.reason, exitCode: event.exit_code, tail: event.tail, summary: event.summary },
          jobType.classify as ClassifyRule[],
          {
            onPatternTimeout: (rule) =>
              log.warn({ jobType: jobType.key, rule }, 'classify rule pattern ran out of time and counts as no match'),
          },
        )
        await update({
          ...move(END[result.state]),
          exit_code: event.exit_code,
          failure_class: result.failureClass,
          failure_summary: result.failureSummary,
          peak_private_bytes: event.peak,
          p95_private_bytes: event.p95,
          p50_private_bytes: event.p50,
          cpu_seconds: event.cpu_seconds,
          swept_processes: event.swept,
          visible_windows: event.visible_windows,
        })
        return
      }
    }
  })
}

type OrphansEvent = Extract<RunEvent, { kind: 'Orphans' }>
type StopMessage = Extract<ControlPlaneMessage, { type: 'Stop' }>
type OrphanLog = { warn(data: { code: string; machineId: string; run: string }, message: string): void }

export const UNSUPERVISED_SUMMARY = 'executor restarted; the run ended while unsupervised'

/**
 * Applies an Orphans event of machine `machineId`, the runs a restarted executor found from its previous process,
 * in one transaction, and returns the Stops to send once it commits. An alive run becomes orphaned with class infra:
 * its job type's `kill` policy answers Stop orphan_policy (orphan_action killed), `let_finish` sends nothing. A dead
 * run failed with class infra, stamped like any executor event (see applyRunEvent). An alive repeat of a run already
 * orphaned to be killed answers its Stop again. An orphan its run cannot take (another machine's, already ended, or a
 * let_finish repeat) is logged and skipped, so the others still apply.
 */
export async function applyOrphans(
  ctx: TenantCtx,
  machineId: string,
  event: OrphansEvent,
  at: Date,
  log: OrphanLog = { warn: (data, message) => process.emitWarning(`${message} ${JSON.stringify(data)}`) },
): Promise<StopMessage[]> {
  return run(ctx, async (trx) => {
    const stops: StopMessage[] = []
    for (const { run: runId, alive } of event.runs) {
      try {
        if (await applyOrphan(trx, machineId, runId, alive, at)) {
          stops.push({ type: 'Stop', run: runId, reason: 'orphan_policy' })
        }
      } catch (err) {
        // Every rejection is raised before the run's update, so the transaction stays usable for the next one.
        if (!(err instanceof DevRoundsError)) throw err
        log.warn({ code: err.code, machineId, run: runId }, 'orphan not applied to its run')
      }
    }
    return stops
  })
}

// Orphaned is terminal, so unbounded this re-sends forever; the executor's RUN_DIR_RETENTION, and a restart re-reports a live orphan anyway.
const ORPHAN_STOP_WINDOW = '7 days'

/**
 * The Stop of every run of `machineId` orphaned to be killed within ORPHAN_STOP_WINDOW, for the gateway to send again after each HelloAck,
 * before any Ack of the session. The executor takes an Ack of its Orphans event with no Stop before it as let_finish,
 * so a Stop lost with a session that dropped after the commit would otherwise leave the orphan running. The
 * executor ignores a Stop of a run it no longer follows.
 */
export function pendingOrphanStops(ctx: TenantCtx, machineId: string): Promise<StopMessage[]> {
  return run(ctx, async (trx) => {
    const rows = await trx
      .selectFrom('runs')
      .select('id')
      .where('machine_id', '=', machineId)
      .where('state', '=', 'orphaned')
      .where('orphan_action', '=', 'killed')
      .where('orphaned_at', '>=', sql<Date>`now() - ${ORPHAN_STOP_WINDOW}::interval`)
      .execute()
    return rows.map((row) => ({ type: 'Stop', run: row.id, reason: 'orphan_policy' }) as const)
  })
}

// True when the run is to be stopped.
async function applyOrphan(trx: Trx, machineId: string, runId: string, alive: boolean, at: Date): Promise<boolean> {
  requireRunId(runId)
  const row = await lockRun(trx, machineId, runId)
  const { stamp, clock_skew_ms } = await clamp(trx, runId, at, row.clock_skew_ms)
  const update = (set: Updateable<RunsTable>) => trx.updateTable('runs').set(set).where('id', '=', runId).execute()
  if (!alive) {
    const next = nextRunState(row.state, 'fail', runId)
    await update({
      state: next.state,
      finished_at: stamp,
      clock_skew_ms,
      failure_class: 'infra',
      failure_summary: UNSUPERVISED_SUMMARY,
    })
    return false
  }
  // The executor restarted again before it acted on the Stop: it still owes the kill. The new report restarts the
  // window in which pendingOrphanStops sends the Stop again.
  if (row.state === 'orphaned' && row.orphan_action === 'killed') {
    await update({ orphaned_at: stamp, clock_skew_ms })
    return true
  }
  const next = nextRunState(row.state, 'orphan', runId)
  const { orphan_policy } = await trx
    .selectFrom('job_types')
    .select('orphan_policy')
    .where('id', '=', row.job_type_id)
    .executeTakeFirstOrThrow()
  const kill = orphan_policy === 'kill'
  await update({
    state: next.state,
    orphaned_at: stamp,
    clock_skew_ms,
    failure_class: 'infra',
    orphan_action: kill ? 'killed' : 'let_finish',
  })
  return kill
}
