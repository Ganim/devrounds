import { type Kysely, sql } from 'kysely'
import type { Database, FlowRunState, JobState } from '../db/schema.ts'
import { DevRoundsError, explain } from '../errors/error.ts'
import { resolver } from '../jobs/enqueue.ts'
import type { Trx } from '../planning/resolve.ts'
import { notifyScheduler } from '../scheduler/notify.ts'
import type { SchedulerLog } from '../scheduler/scheduler.ts'
import { withTenant } from '../tenancy/scope.ts'
import { branchLabel, type FlowDocument, type FlowNode, type JobNode, render } from './document.ts'

// The flow engine (P4 design §2.G 32). A flow run moves only inside the transaction of what moved it: its start, the
// end of the job its node waits on (jobs/outcome.ts endJob), the scheduler tick that wakes a due wait, a cancel. Each
// takes the flow run's row lock first, so two of them never move one run at once. Between two of them a run waits on
// exactly one open node run (a job or a wait); branch, park and finish are passed in the same transaction.
//
// Every job a node makes is a job of the run's task, created by whoever started the run.

// Bounds one move: max_visits bounds every cycle (flows/document.ts), so this only catches a long chain of branches.
const MAX_STEPS = 500

export type FlowRunRow = {
  id: string
  tenant_id: string
  project_id: string
  flow_key: string
  task_id: string
  task_key: string
  created_by: string
  state: FlowRunState
  input: Record<string, string>
  document: FlowDocument
}

type Last = { outcome: string | null; data: Record<string, unknown> }

/** The flow run `id` locked for no key update, with its document and task key; undefined when there is none. */
export async function lockFlowRun(trx: Trx, id: string, opts: { skipLocked?: boolean } = {}) {
  let query = trx
    .selectFrom('flow_runs')
    .select(['id', 'tenant_id', 'project_id', 'flow_id', 'flow_key', 'task_id', 'created_by', 'state', 'input'])
    .where('id', '=', id)
    .forNoKeyUpdate()
  if (opts.skipLocked) query = query.skipLocked()
  const row = await query.executeTakeFirst()
  if (!row) return undefined
  const extra = await trx
    .selectFrom('flows as f')
    .innerJoin('tasks as t', (join) => join.on('t.id', '=', row.task_id))
    .select(['f.document', 't.key as task_key'])
    .where('f.id', '=', row.flow_id)
    .executeTakeFirstOrThrow()
  return {
    ...row,
    input: row.input as Record<string, string>,
    document: extra.document as FlowDocument,
    task_key: extra.task_key,
  } satisfies FlowRunRow
}

/** Writes a plan event of the run's task. */
export async function flowEvent(
  trx: Trx,
  fr: Pick<FlowRunRow, 'tenant_id' | 'project_id' | 'task_id'>,
  actorId: string,
  kind: 'flow_run_start' | 'flow_run_end' | 'flow_run_resume',
  data: object,
  reason: string | null = null,
): Promise<void> {
  await trx
    .insertInto('plan_events')
    .values({
      tenant_id: fr.tenant_id,
      project_id: fr.project_id,
      task_id: fr.task_id,
      actor_id: actorId,
      kind,
      reason,
      data: JSON.stringify(data),
    })
    .execute()
}

/** Ends running flow run `fr` in `state` with `reason`, and records it on the task. */
export async function endFlowRun(
  trx: Trx,
  fr: FlowRunRow,
  state: Exclude<FlowRunState, 'running'>,
  reason: string | null,
  actorId = fr.created_by,
): Promise<void> {
  await trx
    .updateTable('flow_runs')
    .set({ state, reason, ended_at: sql<Date>`now()` })
    .where('id', '=', fr.id)
    .execute()
  fr.state = state
  await flowEvent(trx, fr, actorId, 'flow_run_end', { flow: fr.flow_key, run: fr.id, state }, reason)
}

// The visits of `node` so far and the run's node runs so far (the next seq is one more).
async function countsOf(trx: Trx, flowRunId: string, node: string): Promise<{ visits: number; seq: number }> {
  const { rows } = await sql<{ visits: string; total: string }>`
    select count(*) filter (where node = ${node}) as visits, count(*) as total
    from flow_node_runs where flow_run_id = ${flowRunId}`.execute(trx)
  return { visits: Number(rows[0].visits), seq: Number(rows[0].total) + 1 }
}

// Queues the node's job (and its first run) as a job of the run's task, as `run start` would.
async function createJob(trx: Trx, fr: FlowRunRow, node: JobNode): Promise<string> {
  const values = await resolver(
    trx,
    fr.project_id,
  )({
    jobTypeKey: node.job_type,
    cwd: render(node.cwd, fr.input),
    args: node.args?.map((arg) => render(arg, fr.input)),
    env: node.env && Object.fromEntries(Object.entries(node.env).map(([k, v]) => [k, render(v, fr.input)])),
    queueKey: node.queue,
    machineName: node.machine,
    taskKey: fr.task_key,
  })
  const base = { tenant_id: fr.tenant_id, project_id: fr.project_id }
  const job = await trx
    .insertInto('jobs')
    .values({ ...base, created_by: fr.created_by, ...values })
    .returning('id')
    .executeTakeFirstOrThrow()
  await trx
    .insertInto('runs')
    .values({ ...base, job_id: job.id, job_type_id: values.job_type_id })
    .execute()
  await notifyScheduler(trx, fr.tenant_id)
  return job.id
}

export function edge(node: FlowNode, label: string): string | undefined {
  const next = 'next' in node ? node.next : undefined
  return next?.[label] ?? next?.default
}

/**
 * Enters node `nodeId` of running flow run `fr` (locked by the caller), `last` being the result of the node before
 * it, and passes nodes until one waits or the run ends. A node entered once more than its max_visits parks the run;
 * so does a label with no edge, and a job node whose job cannot be queued (its job type gone, a queue that refuses
 * it): the run stops for a person with the reason, and whatever moved it (a run event) still commits.
 */
export async function proceed(trx: Trx, fr: FlowRunRow, nodeId: string, last: Last): Promise<void> {
  let id = nodeId
  let result = last
  for (let step = 0; step < MAX_STEPS; step++) {
    const node = fr.document.nodes[id]
    const { visits, seq } = await countsOf(trx, fr.id, id)
    const maxVisits = 'max_visits' in node ? node.max_visits : undefined
    if (maxVisits !== undefined && visits >= maxVisits) {
      return endFlowRun(trx, fr, 'parked', `node ${id} reached max_visits ${maxVisits}`)
    }
    const row = { tenant_id: fr.tenant_id, flow_run_id: fr.id, node: id, kind: node.kind, visit: visits + 1, seq }
    const ended = (outcome: string, data: object = {}) =>
      trx
        .insertInto('flow_node_runs')
        .values({ ...row, outcome, data: JSON.stringify(data), ended_at: sql<Date>`now()` })
        .execute()
    switch (node.kind) {
      case 'job': {
        let jobId: string
        try {
          jobId = await createJob(trx, fr, node)
        } catch (err) {
          if (!(err instanceof DevRoundsError)) throw err
          await ended('failed', { error: err.code })
          return endFlowRun(trx, fr, 'parked', `node ${id}: ${explain(err.code, err.data).text}`)
        }
        await trx
          .insertInto('flow_node_runs')
          .values({ ...row, job_id: jobId })
          .execute()
        return
      }
      case 'wait':
        await trx
          .insertInto('flow_node_runs')
          .values({ ...row, wake_at: sql<Date>`now() + make_interval(secs => ${node.duration_s})` })
          .execute()
        return
      case 'park': {
        // What resume checks the answer against is read from here, so it stays the one the person was asked.
        const reason = render(node.reason, fr.input)
        await ended('parked', { reason, ...(node.ask && { ask_schema: node.ask }) })
        return endFlowRun(trx, fr, 'parked', reason)
      }
      case 'finish':
        await ended('done')
        return endFlowRun(trx, fr, 'done', null)
      case 'branch': {
        const label = branchLabel(node, result, fr.input)
        await ended(label, result.data)
        result = { outcome: label, data: result.data }
        const target = edge(node, label)
        if (target === undefined) return endFlowRun(trx, fr, 'parked', `node ${id} has no edge for outcome ${label}`)
        id = target
      }
    }
  }
  return endFlowRun(trx, fr, 'parked', `the flow passed ${MAX_STEPS} nodes without waiting`)
}

// Ends open node run `nodeRun` with `outcome` and `data`, and follows its edge.
async function leave(
  trx: Trx,
  fr: FlowRunRow,
  nodeRun: { id: string; node: string },
  outcome: string,
  data: Record<string, unknown>,
): Promise<void> {
  await trx
    .updateTable('flow_node_runs')
    .set({ outcome, data: JSON.stringify(data), ended_at: sql<Date>`now()` })
    .where('id', '=', nodeRun.id)
    .execute()
  const target = edge(fr.document.nodes[nodeRun.node], outcome)
  if (target === undefined) {
    return endFlowRun(trx, fr, 'parked', `node ${nodeRun.node} has no edge for outcome ${outcome}`)
  }
  return proceed(trx, fr, target, { outcome, data })
}

/**
 * Moves the flow run whose open job node waits on job `jobId`, which just ended in `state`, in the transaction of
 * that end (jobs/outcome.ts endJob). The node leaves with done (finished), failed or stopped and the job's last run
 * as data. A job of no flow, or of a run no longer running (cancelled), changes nothing.
 */
export async function settleFlowJob(trx: Trx, jobId: string, state: JobState): Promise<void> {
  const open = await trx
    .selectFrom('flow_node_runs')
    .select('flow_run_id')
    .where('job_id', '=', jobId)
    .where('ended_at', 'is', null)
    .executeTakeFirst()
  if (!open) return
  const fr = await lockFlowRun(trx, open.flow_run_id)
  if (fr?.state !== 'running') return
  // Read again under the lock: a cancel that committed first closed it.
  const nodeRun = await trx
    .selectFrom('flow_node_runs')
    .select(['id', 'node'])
    .where('job_id', '=', jobId)
    .where('ended_at', 'is', null)
    .executeTakeFirst()
  if (!nodeRun) return
  const last = await trx
    .selectFrom('runs')
    .select(['id', 'exit_code', 'failure_class'])
    .where('job_id', '=', jobId)
    .orderBy('attempt', 'desc')
    .limit(1)
    .executeTakeFirstOrThrow()
  await leave(trx, fr, nodeRun, state === 'finished' ? 'done' : state, {
    run: last.id,
    exit_code: last.exit_code === null ? null : Number(last.exit_code),
    failure_class: last.failure_class,
  })
}

/**
 * Wakes every wait node due at `now`, each flow run in its own transaction, and returns how many moved. The
 * scheduler runs it in every tick, so a wait ends within a poll of its time. The rows come from due_flow_waits
 * (0029) across tenants; each run is locked with skip locked and checked again inside its tenant, so two ticks at
 * once (or a tick of another serve) wake a wait once.
 */
export async function wakeDueFlowWaits(db: Kysely<Database>, now: Date, log: SchedulerLog): Promise<number> {
  const { rows } = await sql<{ tenant_id: string; flow_run_id: string }>`
    select distinct tenant_id, flow_run_id from due_flow_waits(${now})`.execute(db)
  let woken = 0
  for (const row of rows) {
    try {
      const moved = await withTenant(db, row.tenant_id, async (trx) => {
        const fr = await lockFlowRun(trx, row.flow_run_id, { skipLocked: true })
        if (!fr || fr.state !== 'running') return false
        const nodeRun = await trx
          .selectFrom('flow_node_runs')
          .select(['id', 'node'])
          .where('flow_run_id', '=', fr.id)
          .where('ended_at', 'is', null)
          .where('wake_at', '<=', now)
          .executeTakeFirst()
        if (!nodeRun) return false
        await leave(trx, fr, nodeRun, 'done', {})
        return true
      })
      if (moved) woken++
    } catch (err) {
      // The database, usually; the wait is still due, so the next tick tries again.
      log.error({ err, flowRun: row.flow_run_id }, 'flow wait wake failed')
    }
  }
  return woken
}
