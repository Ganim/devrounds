import type { DelayReason, FailureClass, RunCause, RunState, StepOutcome } from '../db/schema.ts'
import { fail } from '../errors/error.ts'
import { findProject, run, type TenantCtx, type Trx } from '../planning/resolve.ts'

// Byte counts, exit codes and cursors are int8 in Postgres but numbers here: the protocol refuses any value past
// 2^53 (executor/protocol.ts), so every one of them fits a JS number exactly.
export type RunView = {
  id: string
  state: RunState
  attempt: number
  jobType: string
  // Null until the run is placed on a machine.
  machine: string | null
  queue: string
  cause: RunCause
  // The run is not placed before this time (a retry's backoff).
  notBefore: Date
  task: string | null
  timeline: {
    queuedAt: Date
    offeredAt: Date | null
    admittedAt: Date | null
    startedAt: Date | null
    finishedAt: Date | null
  }
  // Null while either end is missing.
  durations: {
    // Placeable (the later of queued_at and not_before) → offered: a retry's backoff is not waiting for a machine.
    queueWaitMs: number | null
    admissionDelayMs: number | null // offered → admitted
    runTimeMs: number | null // started → finished
    totalMs: number | null // queued → finished
  }
  outcome: {
    exitCode: number | null
    failureClass: FailureClass | null
    failureSummary: string | null
    logCursor: number | null
  }
  resources: {
    peak: number | null
    p95: number | null
    p50: number | null
    cpuSeconds: number | null
    swept: number | null
    visibleWindows: number | null
  }
  steps: { step: number; name: string; startedAt: Date; finishedAt: Date | null; outcome: StepOutcome | null }[]
  delays: { at: Date; reason: DelayReason; needBytes: number; availableBytes: number | null; position: number }[]
}

// One row of GET /runs (api/view-routes.ts listRuns).
export type RunSummary = {
  id: string
  state: RunState
  attempt: number
  cause: RunCause
  jobType: string
  queue: string
  // Null until the run is placed on a machine.
  machine: string | null
  queuedAt: Date
  finishedAt: Date | null
  failureClass: FailureClass | null
  // queued → finished; null while the run has not ended.
  totalMs: number | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Postgres answers a malformed uuid with an error, i.e. a 500, so ids from requests are checked first.
export const isUuid = (value: string): boolean => UUID.test(value)

/** DR201 unless `runId` can name a run. */
export function requireRunId(runId: string): void {
  if (!isUuid(runId)) fail('DR201', { kind: 'run', key: runId })
}

const num = (value: string | null): number | null => (value === null ? null : Number(value))
const between = (from: Date | null, to: Date | null): number | null =>
  from && to ? to.getTime() - from.getTime() : null
const later = (a: Date, b: Date): Date => (a.getTime() >= b.getTime() ? a : b)

/** With `projectKey`, a run of another project answers DR201 as if it did not exist. */
export async function runView(ctx: TenantCtx, runId: string, projectKey?: string): Promise<RunView> {
  requireRunId(runId)
  return run(ctx, (trx) => loadRunView(trx, runId, projectKey))
}

export async function loadRunView(trx: Trx, runId: string, projectKey?: string): Promise<RunView> {
  const projectId = projectKey === undefined ? undefined : (await findProject(trx, projectKey)).id
  const row = await trx
    .selectFrom('runs as r')
    .innerJoin('jobs as j', 'j.id', 'r.job_id')
    .innerJoin('job_types as jt', 'jt.id', 'r.job_type_id')
    .innerJoin('queues as q', 'q.id', 'j.queue_id')
    .leftJoin('machines as m', 'm.id', 'r.machine_id')
    .leftJoin('tasks as t', 't.id', 'j.task_id')
    .selectAll('r')
    .select(['jt.key as job_type_key', 'm.name as machine_name', 'q.key as queue_key', 't.key as task_key'])
    .where('r.id', '=', runId)
    .$if(projectId !== undefined, (query) => query.where('r.project_id', '=', projectId as string))
    .executeTakeFirst()
  if (!row) fail('DR201', { kind: 'run', key: runId })
  const [steps, delays] = await Promise.all([
    trx
      .selectFrom('run_steps')
      .select(['step', 'name', 'started_at', 'finished_at', 'outcome'])
      .where('run_id', '=', runId)
      .orderBy('step')
      .execute(),
    trx
      .selectFrom('run_delays')
      .select(['at', 'reason', 'need_bytes', 'available_bytes', 'position'])
      .where('run_id', '=', runId)
      .orderBy('id')
      .execute(),
  ])
  return {
    id: row.id,
    state: row.state,
    attempt: row.attempt,
    jobType: row.job_type_key,
    machine: row.machine_name,
    queue: row.queue_key,
    cause: row.cause,
    notBefore: row.not_before,
    task: row.task_key,
    timeline: {
      queuedAt: row.queued_at,
      offeredAt: row.offered_at,
      admittedAt: row.admitted_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    },
    durations: {
      queueWaitMs: between(later(row.queued_at, row.not_before), row.offered_at),
      admissionDelayMs: between(row.offered_at, row.admitted_at),
      runTimeMs: between(row.started_at, row.finished_at),
      totalMs: between(row.queued_at, row.finished_at),
    },
    outcome: {
      exitCode: num(row.exit_code),
      failureClass: row.failure_class,
      failureSummary: row.failure_summary,
      logCursor: num(row.log_cursor),
    },
    resources: {
      peak: num(row.peak_private_bytes),
      p95: num(row.p95_private_bytes),
      p50: num(row.p50_private_bytes),
      cpuSeconds: row.cpu_seconds,
      swept: row.swept_processes,
      visibleWindows: row.visible_windows,
    },
    steps: steps.map((s) => ({
      step: s.step,
      name: s.name,
      startedAt: s.started_at,
      finishedAt: s.finished_at,
      outcome: s.outcome,
    })),
    delays: delays.map((d) => ({
      at: d.at,
      reason: d.reason,
      needBytes: Number(d.need_bytes),
      availableBytes: num(d.available_bytes),
      position: d.position,
    })),
  }
}
