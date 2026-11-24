import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import type { FailureClass, GateState, JobState, RunState } from '../db/schema.ts'
import { fail } from '../errors/error.ts'
import { insertBatch } from '../jobs/enqueue.ts'
import { type Ctx, findProject, run, type TenantCtx, type Trx } from '../planning/resolve.ts'
import { GATES_QUEUE } from '../queues/service.ts'
import { runEvents } from '../runs/dispatch.ts'
import { isUuid } from '../runs/view.ts'
import { validate } from '../validate.ts'
import { GateInput, normalizeCwd } from './file.ts'
import { settleGate } from './settle.ts'

export { GATES_QUEUE, settleGate }

export type GateView = {
  id: string
  key: string
  state: GateState
  machine: string
  cwd: string
  headSha: string | null
  dirty: boolean | null
  batch: string
  createdAt: Date
  finishedAt: Date | null
  // created → finished; null while running.
  wallMs: number | null
  // By ref, each with its job's latest run. durationMs is the run's started → finished (null for a run that never
  // started: queued, skipped, cached).
  checks: {
    ref: string
    jobType: string
    state: JobState
    runId: string
    runState: RunState
    attempt: number
    cachedFrom: string | null
    failureClass: FailureClass | null
    failureSummary: string | null
    durationMs: number | null
    // The run's exit code; a cache hit shows its source run's. Null for a run that never exited.
    exitCode: number | null
  }[]
}

// The gate's machine (plan call 3): the one named, else the tenant's only live machine. The worktree is on the
// caller's machine and DevRounds cannot tell which that is, so with none or several it must be named. Shared lock, as a
// pin takes (jobs/enqueue.ts): a revoke waits for this transaction and then sweeps the new pinned runs.
async function gateMachine(trx: Trx, name: string | undefined): Promise<{ id: string; name: string }> {
  const live = trx.selectFrom('machines').select(['id', 'name']).where('revoked_at', 'is', null)
  if (name !== undefined) {
    return (
      (await live.where('name', '=', name).forShare().executeTakeFirst()) ??
      fail('DR201', { kind: 'machine', key: name })
    )
  }
  const rows = await live.orderBy('name').limit(2).forShare().execute()
  if (rows.length === 1) return rows[0]
  return fail('DR101', {
    path: '/machine',
    reason:
      rows.length === 0
        ? 'is required: the tenant has no live machine'
        : 'is required when the tenant has more than one live machine',
  })
}

/**
 * Submits a gate: its checks as one batch, every check pinned to the gate's machine with the gate's cwd, in the file's
 * queue (default `gates`), all in one transaction. One gate runs per worktree (project, machine, normalized cwd): a
 * submit while another gate of the worktree runs answers DR308 naming it. Submits of one worktree are serialized by an
 * advisory lock taken before the holder is read, so two at once make one gate and one DR308, never a unique
 * violation of gates_worktree_lock. A gate whose every check is a cache hit ends here, passed, and holds nothing.
 */
export async function submitGate(ctx: Ctx, projectKey: string, input: GateInput): Promise<GateView> {
  validate(GateInput, input)
  // The id is chosen here so DR152 can name the batch it refuses.
  const batchId = randomUUID()
  return run(ctx, async (trx) => {
    const project = await findProject(trx, projectKey)
    const machine = await gateMachine(trx, input.machine)
    const cwdKey = normalizeCwd(input.cwd)
    await sql`select pg_advisory_xact_lock(hashtextextended(${`devrounds.gate:${project.id}:${machine.id}:${cwdKey}`}, 0))`.execute(
      trx,
    )
    const holder = await trx
      .selectFrom('gates')
      .select('id')
      .where('project_id', '=', project.id)
      .where('machine_id', '=', machine.id)
      .where('cwd_key', '=', cwdKey)
      .where('state', '=', 'running')
      .executeTakeFirst()
    if (holder) fail('DR308', { cwd: input.cwd, machine: machine.name, gate: holder.id })
    await trx
      .insertInto('job_batches')
      .values({ id: batchId, tenant_id: ctx.tenantId, project_id: project.id, created_by: ctx.actor.id })
      .execute()
    await insertBatch(
      trx,
      ctx,
      project.id,
      batchId,
      { jobs: input.file.checks },
      { machineId: machine.id, queueKey: input.file.queue ?? GATES_QUEUE, cwd: input.cwd, listPath: '/checks' },
    )
    const { id } = await trx
      .insertInto('gates')
      .values({
        tenant_id: ctx.tenantId,
        project_id: project.id,
        key: input.file.key,
        machine_id: machine.id,
        cwd: input.cwd,
        cwd_key: cwdKey,
        head_sha: input.headSha ?? null,
        dirty: input.dirty ?? null,
        batch_id: batchId,
        created_by: ctx.actor.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await settleGate(trx, batchId)
    return loadGateView(trx, project.id, id)
  })
}

/** A gate of another project or tenant answers DR201 as if it did not exist. */
export async function gateView(ctx: TenantCtx, projectKey: string, id: string): Promise<GateView> {
  if (!isUuid(id)) fail('DR201', { kind: 'gate', key: id })
  return run(ctx, async (trx) => loadGateView(trx, (await findProject(trx, projectKey)).id, id))
}

/**
 * The gate once it ended, or as it is after `waitS` seconds. Wakes when one of its checks' runs changes (runEvents, as
 * waitForRun); an aborted `signal` (the client went away) ends the wait early with the gate as it is.
 */
export async function waitForGate(
  ctx: TenantCtx,
  projectKey: string,
  id: string,
  waitS: number,
  opts: { signal?: AbortSignal } = {},
): Promise<GateView> {
  const { signal } = opts
  const deadline = Date.now() + waitS * 1000
  let wake: (() => void) | undefined
  let dirty = false
  // While a read is in flight `runs` is the previous read's (empty for the first), so an event it does not list may
  // still belong to this gate: any event then counts, and the loop reads again.
  let reading = false
  // The checks' runs of the last read. A policy retry or a skip is announced together with the run that ended, which is
  // in it, so the next read picks the new run up. A person's retry announces nothing; the wait then ends at waitS.
  let runs = new Set<string>()
  const listener = (changed: string) => {
    if (!reading && !runs.has(changed)) return
    dirty = true
    wake?.()
  }
  const abort = () => wake?.()
  // Subscribed before the first read, so a change applied between a read and the wait is not missed.
  runEvents.on('changed', listener)
  signal?.addEventListener('abort', abort)
  try {
    for (;;) {
      dirty = false
      reading = true
      let view: GateView
      try {
        view = await gateView(ctx, projectKey, id)
      } finally {
        reading = false
      }
      runs = new Set(view.checks.map((check) => check.runId))
      const left = deadline - Date.now()
      if (view.state !== 'running' || left <= 0 || signal?.aborted) return view
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

const msBetween = (from: Date | null, to: Date | null) =>
  from === null || to === null ? null : to.getTime() - from.getTime()

const exitCodeOf = (value: string | null) => (value === null ? null : Number(value))

async function loadGateView(trx: Trx, projectId: string, id: string): Promise<GateView> {
  const gate = await trx
    .selectFrom('gates as g')
    .innerJoin('machines as m', 'm.id', 'g.machine_id')
    .select([
      'g.id',
      'g.key',
      'g.state',
      'm.name as machine',
      'g.cwd',
      'g.head_sha',
      'g.dirty',
      'g.batch_id',
      'g.created_at',
      'g.finished_at',
    ])
    .where('g.id', '=', id)
    .where('g.project_id', '=', projectId)
    .executeTakeFirst()
  if (!gate) fail('DR201', { kind: 'gate', key: id })
  const checks = await trx
    .selectFrom('jobs as j')
    .innerJoin('job_types as jt', 'jt.id', 'j.job_type_id')
    .innerJoin('runs as r', 'r.job_id', 'j.id')
    .leftJoin('runs as src', 'src.id', 'r.cached_from_run_id')
    .select([
      'j.ref',
      'jt.key as job_type',
      'j.state',
      'r.id as run_id',
      'r.state as run_state',
      'r.attempt',
      'r.cached_from_run_id',
      'r.failure_class',
      'r.failure_summary',
      'r.started_at',
      'r.finished_at',
      'r.exit_code',
      'src.exit_code as source_exit_code',
    ])
    .where('j.batch_id', '=', gate.batch_id)
    .where(({ eb, selectFrom }) =>
      eb(
        'r.attempt',
        '=',
        selectFrom('runs as last')
          .select(({ fn }) => fn.max('last.attempt').as('a'))
          .whereRef('last.job_id', '=', 'j.id'),
      ),
    )
    .orderBy('j.ref')
    .execute()
  return {
    id: gate.id,
    key: gate.key,
    state: gate.state,
    machine: gate.machine,
    cwd: gate.cwd,
    headSha: gate.head_sha,
    dirty: gate.dirty,
    batch: gate.batch_id,
    createdAt: gate.created_at,
    finishedAt: gate.finished_at,
    wallMs: msBetween(gate.created_at, gate.finished_at),
    checks: checks.map((check) => ({
      ref: check.ref as string,
      jobType: check.job_type,
      state: check.state,
      runId: check.run_id,
      runState: check.run_state,
      attempt: check.attempt,
      cachedFrom: check.cached_from_run_id,
      failureClass: check.failure_class,
      failureSummary: check.failure_summary,
      durationMs: msBetween(check.started_at, check.finished_at),
      exitCode: exitCodeOf(check.exit_code ?? check.source_exit_code),
    })),
  }
}
