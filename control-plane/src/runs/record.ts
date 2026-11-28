import { sql, type Updateable } from 'kysely'
import type { JobState, RunState, RunsTable } from '../db/schema.ts'
import { settleAgentRun } from '../engines/agent-runtime/engine.ts'
import { type JobTypeEnvironment, runEnvironment } from '../environments/index.ts'
import { DevRoundsError, fail } from '../errors/error.ts'
import type { ControlPlaneMessage, RunEvent } from '../executor/protocol.ts'
import { findJobType } from '../job-types/service.ts'
import { failJob, queueRetry, settledRuns, settleJob, skippedSummary } from '../jobs/outcome.ts'
import { type Ctx, findProject, findTask, run, type TenantCtx, type Trx } from '../planning/resolve.ts'
import { ensureQueue } from '../queues/service.ts'
import { notifyScheduler } from '../scheduler/notify.ts'
import { formatTraceParent, parseTraceParent, type Telemetry } from '../telemetry/otel.ts'
import { type ClassifyRule, classifyRun } from './classify.ts'
import { int4, int8 } from './int-columns.ts'
import { updateLearnedNeed } from './learned-need.ts'
import { nextRunState, type RunTransition, TERMINAL } from './states.ts'
import { loadRunView, type RunView, requireRunId } from './view.ts'

const INT_MAX = 2147483647

/** Records a job (in the project's `default` queue) and its first run, queued, already on the live machine named
 * `machineName`, and wakes nobody: with markOffered it sets up an offered run without the scheduler (tests and
 * fixtures). Runs to be placed go through jobs/enqueue.ts. */
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
    const queue = await ensureQueue(trx, project.id)
    const job = await trx
      .insertInto('jobs')
      .values({
        tenant_id: ctx.tenantId,
        project_id: project.id,
        job_type_id: jobType.id,
        task_id: task?.id ?? null,
        cwd: i.cwd,
        machine_id: machine.id,
        queue_id: queue.id,
        created_by: ctx.actor.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const { id } = await trx
      .insertInto('runs')
      .values({
        tenant_id: ctx.tenantId,
        job_id: job.id,
        project_id: project.id,
        job_type_id: jobType.id,
        machine_id: machine.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return loadRunView(trx, id)
  })
}

/**
 * A person's retry: a new run of the same job (same job type, machine, cwd and task), attempt + 1, cause retry, and
 * the job open again. Only an ended run is retried; the job type's max_attempts bounds automatic retries only. A job
 * pinned to a revoked machine answers DR201 for the machine, as a new pin to it would (jobs/enqueue.ts): no claim
 * would ever take the run. The job's skipped dependents open again too (reopenDependents), unless a dependency of the
 * job is still red: then the new run is skipped at once, naming that dependency, and nothing reopens.
 */
export async function retryRun(ctx: Ctx, runId: string): Promise<RunView> {
  requireRunId(runId)
  return run(ctx, async (trx) => {
    const previous = await trx
      .selectFrom('runs as r')
      .innerJoin('jobs as j', 'j.id', 'r.job_id')
      .select(['r.job_id', 'r.state', 'j.machine_id'])
      .where('r.id', '=', runId)
      .executeTakeFirst()
    if (!previous) fail('DR201', { kind: 'run', key: runId })
    if (!TERMINAL.includes(previous.state)) fail('DR351', { run: runId, state: previous.state })
    if (previous.machine_id !== null) {
      // Shared, and first in the lock order (machine → run → job): a revoke cannot commit between this check and the
      // new run. Here and not in queueRetry, whose automatic callers already hold a run row.
      const machine = await trx
        .selectFrom('machines')
        .select(['name', 'revoked_at'])
        .where('id', '=', previous.machine_id)
        .forShare()
        .executeTakeFirstOrThrow()
      if (machine.revoked_at !== null) fail('DR201', { kind: 'machine', key: machine.name })
    }
    // Locked before the dependencies are read, as queueRetry would lock it. claim_run never takes a job behind a red
    // dependency, so the new run would wait queued for good: it is skipped at once, as settling would have, and
    // reopens nothing. Its cause is requeue: it never runs, so it must not cost the job an automatic retry later.
    await trx.selectFrom('jobs').select('id').where('id', '=', previous.job_id).forNoKeyUpdate().execute()
    const red = await redDependency(trx, previous.job_id)
    const retryId = await queueRetry(trx, ctx.tenantId, previous.job_id, sql<Date>`now()`, red ? 'requeue' : 'retry')
    if (red) {
      await trx
        .updateTable('runs')
        .set({
          state: 'skipped',
          finished_at: sql<Date>`now()`,
          failure_summary: skippedSummary(red.ref ?? red.id, red.state),
        })
        .where('id', '=', retryId)
        .execute()
      await trx.updateTable('jobs').set({ state: 'skipped' }).where('id', '=', previous.job_id).execute()
      return loadRunView(trx, retryId)
    }
    await reopenDependents(trx, ctx.tenantId, previous.job_id)
    await notifyScheduler(trx, ctx.tenantId)
    return loadRunView(trx, retryId)
  })
}

/**
 * Opens again, with a new queued run each, the skipped dependents of job `jobId` that a retry just opened, transitively.
 * A dependent was skipped only because a dependency went red, so it opens once none of its dependencies is red any
 * more (failed, stopped or skipped); claim_run then holds it until they all finish, and a red end skips it again
 * (jobs/outcome.ts). The new run's cause is requeue: the skipped run never ran, so it is no attempt. A dependent pinned
 * to a revoked machine stays skipped, as no claim could take it.
 */
async function reopenDependents(trx: Trx, tenantId: string, jobId: string): Promise<void> {
  let frontier = [jobId]
  while (frontier.length > 0) {
    const { rows } = await sql<{ id: string; machine_id: string | null }>`
      select distinct j.id, j.machine_id
      from job_dependencies d
      join jobs j on j.id = d.job_id
      where d.depends_on_job_id = any(${frontier}::uuid[])
        and j.state = 'skipped'
        and not exists (
          select 1 from job_dependencies o join jobs oj on oj.id = o.depends_on_job_id
          where o.job_id = j.id and oj.state in ('failed', 'stopped', 'skipped')
        )
      order by j.id`.execute(trx)
    frontier = []
    for (const row of rows) {
      if (row.machine_id !== null) {
        // Shared, as in retryRun, so a revoke cannot commit between this check and the new run. Taken after job rows,
        // against the machine → job order. A revoke of this machine in flight would lock unpinned jobs too (the job
        // of an active unpinned run, the open dependents of a failed pinned job), so the safety is elsewhere: a
        // dependent gets here only when skipped with no red dependency, and only a pin to an already revoked machine
        // leaves it in that state, so that revoke has committed. Should the case still arise, Postgres aborts one
        // side with 40P01 (deadlock detected) rather than hang.
        const machine = await trx
          .selectFrom('machines')
          .select('revoked_at')
          .where('id', '=', row.machine_id)
          .forShare()
          .executeTakeFirstOrThrow()
        if (machine.revoked_at !== null) continue
      }
      // queueRetry opens the job, so the next round sees it as no longer red.
      await queueRetry(trx, tenantId, row.id, sql<Date>`now()`, 'requeue')
      frontier.push(row.id)
    }
  }
}

/**
 * The dependency to name for job `jobId` being held back, or undefined when none of its dependencies is red: the
 * nearest failed or stopped job reached through its dependencies and their skipped ones (the cause settling names,
 * jobs/outcome.ts), else a skipped dependency itself.
 */
async function redDependency(
  trx: Trx,
  jobId: string,
): Promise<{ id: string; ref: string | null; state: JobState } | undefined> {
  const { rows } = await sql<{ id: string; ref: string | null; state: JobState }>`
    with recursive up (id, depth) as (
      select d.depends_on_job_id, 1 from job_dependencies d where d.job_id = ${jobId}
      union
      select d.depends_on_job_id, u.depth + 1
      from up u join jobs uj on uj.id = u.id join job_dependencies d on d.job_id = u.id
      where uj.state = 'skipped'
    )
    select j.id, j.ref, j.state from up join jobs j on j.id = up.id
    where j.state in ('failed', 'stopped', 'skipped')
    order by j.state = 'skipped', up.depth, j.ref, j.id
    limit 1`.execute(trx)
  return rows[0]
}

/**
 * queued → offered, stamped with the control plane clock when the Offer goes out. `traceParent` is the run.dispatch
 * span's (telemetry on); its trace and span ids are kept for a re-sent Offer and for run.record.
 */
export async function markOffered(ctx: TenantCtx, runId: string, traceParent: string | null = null): Promise<void> {
  requireRunId(runId)
  const trace = parseTraceParent(traceParent)
  return run(ctx, async (trx) => {
    const row = await trx.selectFrom('runs').select('state').where('id', '=', runId).forNoKeyUpdate().executeTakeFirst()
    if (!row) fail('DR201', { kind: 'run', key: runId })
    const next = nextRunState(row.state, 'offer', runId)
    await trx
      .updateTable('runs')
      .set({
        state: next.state,
        offered_at: sql<Date>`now()`,
        trace_id: trace?.traceId ?? null,
        trace_span_id: trace?.spanId ?? null,
      })
      .where('id', '=', runId)
      .execute()
  })
}

/** The traceparent an Offer of a run carries: its dispatch span's, or null when it was dispatched untraced. */
export function runTraceParent(row: { trace_id: string | null; trace_span_id: string | null }): string | null {
  return row.trace_id && row.trace_span_id ? formatTraceParent(row.trace_id, row.trace_span_id) : null
}

/**
 * Exports run.record for a run the executor reported finished; call it after the commit. A failure is logged and
 * changes nothing: telemetry never fails the event that triggered it.
 */
export async function reportFinished(
  ctx: TenantCtx,
  telemetry: Telemetry,
  runId: string,
  log: { warn(data: { err: unknown; run: string }, message: string): void },
): Promise<void> {
  try {
    const { view, traceParent } = await run(ctx, async (trx) => {
      const row = await trx
        .selectFrom('runs')
        .select(['trace_id', 'trace_span_id'])
        .where('id', '=', runId)
        .executeTakeFirstOrThrow()
      return { view: await loadRunView(trx, runId), traceParent: runTraceParent(row) }
    })
    telemetry.runFinished(view, traceParent)
  } catch (err) {
    log.warn({ err, run: runId }, 'run.record span not exported')
  }
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

// The job type's environment when its run starts. The Offer took it when it was sent, so a job type changed in between
// stores a reading against the new environment (or none); accepted, as only the stored reading is off.
async function jobTypeEnvironment(trx: Trx, jobTypeId: string): Promise<JobTypeEnvironment | null> {
  const { environment } = await trx
    .selectFrom('job_types')
    .select('environment')
    .where('id', '=', jobTypeId)
    .executeTakeFirstOrThrow()
  return environment as JobTypeEnvironment | null
}

// The run of `machineId`, locked for its update; DR201 for a run of another machine, as for every executor event.
async function lockRun(trx: Trx, machineId: string, runId: string) {
  const row = await trx
    .selectFrom('runs')
    .select(['state', 'clock_skew_ms', 'project_id', 'job_type_id', 'orphan_action', 'offer_accepted_at'])
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
 * `log` gets the one warning a classification that ran out of pattern budget writes. Returns the other runs the event
 * changed (a retry queued, dependents skipped), whose waiters the caller wakes after the commit.
 */
export async function applyRunEvent(
  ctx: TenantCtx,
  machineId: string,
  event: RunEvent,
  at: Date,
  log: PatternLog = { warn: (data, message) => process.emitWarning(`${message} ${JSON.stringify(data)}`) },
): Promise<string[]> {
  if (event.kind === 'LogSegment' || event.kind === 'Orphans') return []
  requireRunId(event.run)
  const runId = event.run
  let others: string[] = []
  await run(ctx, async (trx) => {
    const row = await lockRun(trx, machineId, runId)
    const { stamp, clock_skew_ms } = await clamp(trx, runId, at, row.clock_skew_ms)
    const move = (transition: RunTransition): Updateable<RunsTable> => {
      const next = nextRunState(row.state, transition, runId)
      const set: Updateable<RunsTable> = { state: next.state, clock_skew_ms }
      if (next.stamp) set[next.stamp] = stamp
      return set
    }
    // Any answer to the offer accepts it, Delayed included: the executor has the run, so its offer no longer expires
    // (scheduler/expiry.ts). The database's clock, like offer_expires_at.
    const accepts = row.state === 'offered' && row.offer_accepted_at === null
    const update = (set: Updateable<RunsTable>) =>
      trx
        .updateTable('runs')
        .set(set)
        .$if(accepts, (query) => query.set({ offer_accepted_at: sql<Date>`now()` }))
        .where('id', '=', runId)
        .execute()
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
            position: int4(event.position),
          })
          .execute()
        return
      case 'RunStarted': {
        const environment = await jobTypeEnvironment(trx, row.job_type_id)
        await update({
          ...move('start'),
          pid: int4(event.pid),
          // FILETIME passes 2^53, so it stays a decimal string from the wire to the int8 column.
          process_start_time: int8(event.start_time),
          boot_id: event.boot_id,
          ...(environment ? { environment: JSON.stringify(runEnvironment(environment, event.environment)) } : {}),
        })
        return
      }
      case 'StepStarted': {
        requireRunning()
        await update({ clock_skew_ms })
        const inserted = await trx
          .insertInto('run_steps')
          .values({
            tenant_id: ctx.tenantId,
            run_id: runId,
            step: int4(event.step),
            name: event.name,
            started_at: stamp,
          })
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
          .where('step', '=', int4(event.step))
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
        const classified = await classifyRun(
          { reason: event.reason, exitCode: event.exit_code, tail: event.tail, summary: event.summary },
          jobType.classify as ClassifyRule[],
          {
            onPatternTimeout: (rule) =>
              log.warn({ jobType: jobType.key, rule }, 'classify rule pattern ran out of time and counts as no match'),
          },
        )
        // An agent run ends by its result, usage and session, read from its agent_events (engines/agent-runtime).
        const result = (await settleAgentRun(trx, ctx.tenantId, runId, event.reason, classified)) ?? classified
        await update({
          ...move(END[result.state]),
          exit_code: event.exit_code,
          failure_class: result.failureClass,
          failure_summary: result.failureSummary,
          peak_private_bytes: event.peak,
          p95_private_bytes: event.p95,
          p50_private_bytes: event.p50,
          cpu_seconds: event.cpu_seconds,
          swept_processes: int4(event.swept),
          visible_windows: int4(event.visible_windows),
        })
        // Same transaction as the peak, so the next claim already places by it.
        await updateLearnedNeed(trx, row.project_id, row.job_type_id, machineId)
        others = settledRuns(await settleJob(trx, ctx.tenantId, runId))
        // An ended run frees its memory, its queue slot and its dependents: the scheduler looks again at the commit.
        await notifyScheduler(trx, ctx.tenantId)
        return
      }
    }
  })
  return others
}

/**
 * Ends every run of the revoked machine `machine` that has not ended (offered, admitted or running), or only `runId`
 * with it, and every queued run of a job pinned to it, inside `trx`. A revoked executor never reports again and no
 * claim takes a run pinned to it, so these runs could never end otherwise. finished_at is no earlier than any stamp on
 * the run, so no duration is negative; the class is always infra.
 *
 * - running: failed, and its job settled as for any failure (jobs/outcome.ts): it ran, so it is an attempt.
 * - offered or admitted: it never started, so it is handled like an expired offer (scheduler/expiry.ts): stopped,
 *   withdrawn like any withdrawn offer, and its job requeued, cause requeue, which never counts toward max_attempts.
 * - queued (pinned): stopped.
 * A job pinned to the machine is never retried or requeued, as every new run would be pinned there too: it fails once
 * (failJob) and its dependents are skipped. Returns every run changed (ended, requeued, retried and skipped) for the
 * caller to wake their waiters, and wakes the scheduler at the commit.
 */
export async function failRevokedRuns(
  trx: Trx,
  machine: { id: string; name: string },
  runId?: string,
): Promise<string[]> {
  const revoked = `machine ${machine.name} was revoked`
  // A queued resume of an agent session that lived on this machine starts a new session on any machine instead.
  await trx
    .updateTable('runs')
    .set({ pinned_machine_id: null, resumed_from_run_id: null })
    .where('state', '=', 'queued')
    .where('pinned_machine_id', '=', machine.id)
    .execute()
  // One statement locks every run row before any job row is touched below (lock order run → job).
  const { rows } = await sql<{ id: string; tenant_id: string; job_id: string; was: RunState; pinned: boolean }>`
    with target as (
      select r.id, r.state as was, j.machine_id is not null as pinned
      from runs r join jobs j on j.id = r.job_id
      where (r.machine_id = ${machine.id} and r.state in ('offered', 'admitted', 'running')
          ${runId === undefined ? sql`` : sql`and r.id = ${runId}`})
        or (r.state = 'queued' and j.machine_id = ${machine.id})
      for no key update of r
    )
    update runs r set
      state = case when t.was = 'running' then 'failed' else 'stopped' end,
      finished_at = greatest(now(), r.offered_at, r.admitted_at, r.started_at),
      failure_class = 'infra',
      failure_summary = case
        when t.was = 'running' then ${`${revoked}; the run cannot report its end`}
        when t.pinned then ${`${revoked}; the job is pinned to it`}
        else ${`${revoked} before the run started; requeued`}
      end,
      withdrawn_at = case when t.was in ('offered', 'admitted') then now() else r.withdrawn_at end
    from target t
    where r.id = t.id
    returning r.id, r.tenant_id, r.job_id, t.was, t.pinned`.execute(trx)
  // Its own statement, so its own snapshot: a transaction the one above waited on (an executor event or the expiry
  // holding a run of a pinned job) may have committed a retry or requeue still pinned here, which that statement's
  // snapshot could not see. Nothing can add another after this: every writer of a pinned run takes the machine row or
  // a run row this transaction now holds. Before any job row is touched, as above.
  const late = await trx
    .updateTable('runs')
    .set({
      state: 'stopped',
      finished_at: sql<Date>`now()`,
      failure_class: 'infra',
      failure_summary: `${revoked}; the job is pinned to it`,
    })
    .where('state', '=', 'queued')
    .where('job_id', 'in', trx.selectFrom('jobs').select('id').where('machine_id', '=', machine.id))
    .returning(['id', 'tenant_id', 'job_id'])
    .execute()
  rows.push(...late.map((row) => ({ ...row, was: 'queued' as const, pinned: true })))
  const changed = new Set<string>()
  for (const row of rows) {
    changed.add(row.id)
    const others = row.pinned
      ? await failJob(trx, row.job_id)
      : row.was === 'running'
        ? settledRuns(await settleJob(trx, row.tenant_id, row.id))
        : [await queueRetry(trx, row.tenant_id, row.job_id, sql<Date>`now()`, 'requeue')]
    for (const other of others) changed.add(other)
  }
  // A machine belongs to one tenant, and every row above is one of its runs or of a job pinned to it.
  if (rows.length > 0) await notifyScheduler(trx, rows[0].tenant_id)
  return [...changed]
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
 * let_finish repeat) is logged and skipped, so the others still apply. An applied orphan ends its run, so it settles
 * the run's job (jobs/outcome.ts: no retry, the job fails) and wakes the scheduler at the commit. `changed` lists the
 * other runs settling changed (dependents skipped), whose waiters the caller wakes after the commit.
 */
export async function applyOrphans(
  ctx: TenantCtx,
  machineId: string,
  event: OrphansEvent,
  at: Date,
  log: OrphanLog = { warn: (data, message) => process.emitWarning(`${message} ${JSON.stringify(data)}`) },
): Promise<{ stops: StopMessage[]; changed: string[] }> {
  return run(ctx, async (trx) => {
    const stops: StopMessage[] = []
    const changed: string[] = []
    let applied = 0
    for (const { run: runId, alive } of event.runs) {
      let plan: OrphanPlan
      try {
        plan = await planOrphan(trx, machineId, runId, alive, at)
      } catch (err) {
        // Only the checks run in here and they write nothing, so the transaction stays usable for the next orphan.
        if (!(err instanceof DevRoundsError)) throw err
        log.warn({ code: err.code, machineId, run: runId }, 'orphan not applied to its run')
        continue
      }
      // Past the checks every failure, a DevRoundsError included, aborts the whole event: a write already made must
      // never be kept without the rest of its orphan.
      await trx.updateTable('runs').set(plan.set).where('id', '=', runId).execute()
      if (plan.ends) changed.push(...settledRuns(await settleJob(trx, ctx.tenantId, runId)))
      if (plan.kill) stops.push({ type: 'Stop', run: runId, reason: 'orphan_policy' })
      applied += 1
    }
    if (applied > 0) await notifyScheduler(trx, ctx.tenantId)
    return { stops, changed }
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

// What one orphan does to its run: the update, whether the run ends (and so settles its job) and whether to stop it.
type OrphanPlan = { set: Updateable<RunsTable>; ends: boolean; kill: boolean }

// Reads and checks only, so a rejection (DR201, DR351, an input code) leaves nothing half written.
async function planOrphan(trx: Trx, machineId: string, runId: string, alive: boolean, at: Date): Promise<OrphanPlan> {
  requireRunId(runId)
  const row = await lockRun(trx, machineId, runId)
  const { stamp, clock_skew_ms } = await clamp(trx, runId, at, row.clock_skew_ms)
  if (!alive) {
    const next = nextRunState(row.state, 'fail', runId)
    const set: Updateable<RunsTable> = {
      state: next.state,
      finished_at: stamp,
      clock_skew_ms,
      failure_class: 'infra',
      failure_summary: UNSUPERVISED_SUMMARY,
    }
    return { set, ends: true, kill: false }
  }
  // The executor restarted again before it acted on the Stop: it still owes the kill. The new report restarts the
  // window in which pendingOrphanStops sends the Stop again.
  if (row.state === 'orphaned' && row.orphan_action === 'killed') {
    return { set: { orphaned_at: stamp, clock_skew_ms }, ends: false, kill: true }
  }
  const next = nextRunState(row.state, 'orphan', runId)
  const { orphan_policy } = await trx
    .selectFrom('job_types')
    .select('orphan_policy')
    .where('id', '=', row.job_type_id)
    .executeTakeFirstOrThrow()
  const kill = orphan_policy === 'kill'
  const set: Updateable<RunsTable> = {
    state: next.state,
    orphaned_at: stamp,
    clock_skew_ms,
    failure_class: 'infra',
    orphan_action: kill ? 'killed' : 'let_finish',
  }
  return { set, ends: true, kill }
}
