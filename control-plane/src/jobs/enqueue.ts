import { randomUUID } from 'node:crypto'
import type { FailureClass, JobState, RunState } from '../db/schema.ts'
import { fail } from '../errors/error.ts'
import { findJobType } from '../job-types/service.ts'
import { type Ctx, findProject, findTask, run, type TenantCtx, type Trx } from '../planning/resolve.ts'
import { DEFAULT_QUEUE, ensureQueue, type QueueRow } from '../queues/service.ts'
import { isUuid, loadRunView, type RunView } from '../runs/view.ts'
import { notifyScheduler } from '../scheduler/notify.ts'
import { validate } from '../validate.ts'
import { BatchInput } from './batch-file.ts'
import { checkGraph } from './graph.ts'

export type EnqueueInput = {
  projectKey: string
  jobTypeKey: string
  cwd: string
  machineName?: string
  queueKey?: string
  taskKey?: string
}

export type BatchView = {
  id: string
  // By ref; runId is the job's latest run.
  jobs: { ref: string; jobId: string; runId: string; jobType: string; state: JobState }[]
}

// One row of GET /jobs (api/view-routes.ts listJobs).
export type JobSummary = {
  id: string
  // Null for a job not made by a batch (`run start`, a schedule).
  ref: string | null
  batch: string | null
  jobType: string
  state: JobState
  // Runs with cause first or retry: a requeue is not the job's fault and never counts (jobs/outcome.ts).
  attempts: number
  // Refs of the jobs it waits for (the id for one without a ref).
  dependsOn: string[]
  lastRun: { id: string; state: RunState; failureClass: FailureClass | null }
}

type JobValues = {
  job_type_id: string
  queue_id: string
  machine_id: string | null
  task_id: string | null
  cwd: string
}

function cached<T>(load: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const seen = new Map<string, T>()
  return async (key) => {
    const hit = seen.get(key)
    if (hit !== undefined) return hit
    const value = await load(key)
    seen.set(key, value)
    return value
  }
}

// Resolves the keys of one job inside the project. Lookups repeat across the jobs of a batch, so they are cached
// per call.
export function resolver(trx: Trx, projectId: string) {
  const jobType = cached((key) => findJobType(trx, projectId, key))
  const queue = cached(async (key): Promise<QueueRow & { allowed: Set<string> }> => {
    const row = await ensureQueue(trx, projectId, key)
    const listed = await trx
      .selectFrom('queue_job_types')
      .select('job_type_id')
      .where('queue_id', '=', row.id)
      .execute()
    return { ...row, allowed: new Set(listed.map((l) => l.job_type_id)) }
  })
  // A pin names a live machine of the tenant; a revoked one could never run the job.
  const machine = cached(async (name) => {
    const row = await trx
      .selectFrom('machines')
      .select('id')
      .where('name', '=', name)
      .where('revoked_at', 'is', null)
      .executeTakeFirst()
    return row?.id ?? fail('DR201', { kind: 'machine', key: name })
  })

  return async (i: Omit<EnqueueInput, 'projectKey'>): Promise<JobValues> => {
    const type = await jobType(i.jobTypeKey)
    const q = await queue(i.queueKey ?? DEFAULT_QUEUE)
    // A queue that lists no job types takes every one.
    if (q.allowed.size > 0 && !q.allowed.has(type.id)) fail('DR153', { jobType: type.key, queue: q.key })
    return {
      job_type_id: type.id,
      queue_id: q.id,
      machine_id: i.machineName === undefined ? null : await machine(i.machineName),
      task_id: i.taskKey === undefined ? null : (await findTask(trx, projectId, i.taskKey)).id,
      cwd: i.cwd,
    }
  }
}

/**
 * Queues a job outside any batch and its first run (attempt 1, cause first, no machine until the scheduler places
 * it), then wakes the scheduler at commit.
 */
export function enqueueRun(ctx: Ctx, i: EnqueueInput): Promise<RunView> {
  return run(ctx, async (trx) => {
    const project = await findProject(trx, i.projectKey)
    const values = await resolver(trx, project.id)(i)
    const job = await trx
      .insertInto('jobs')
      .values({ tenant_id: ctx.tenantId, project_id: project.id, created_by: ctx.actor.id, ...values })
      .returning('id')
      .executeTakeFirstOrThrow()
    const { id } = await trx
      .insertInto('runs')
      .values({ tenant_id: ctx.tenantId, project_id: project.id, job_id: job.id, job_type_id: values.job_type_id })
      .returning('id')
      .executeTakeFirstOrThrow()
    await notifyScheduler(trx, ctx.tenantId)
    return loadRunView(trx, id)
  })
}

/**
 * Queues every job of `input` with its first run and its depends_on edges, in one transaction. The graph is checked
 * before anything is written, and any error (graph, unknown key, DR153) leaves nothing behind.
 */
export async function submitBatch(ctx: Ctx, projectKey: string, input: BatchInput): Promise<BatchView> {
  validate(BatchInput, input)
  // The id is chosen here so DR152 can name the batch it refuses.
  const batchId = randomUUID()
  checkGraph(
    batchId,
    input.jobs.map((job) => ({ ref: job.ref, dependsOn: job.depends_on ?? [] })),
  )
  return run(ctx, async (trx) => {
    const project = await findProject(trx, projectKey)
    const resolve = resolver(trx, project.id)
    const rows = []
    for (const job of input.jobs) {
      const values = await resolve({
        jobTypeKey: job.job_type,
        cwd: job.cwd,
        machineName: job.machine,
        queueKey: job.queue,
        taskKey: job.task,
      })
      rows.push({ tenant_id: ctx.tenantId, project_id: project.id, created_by: ctx.actor.id, ...values })
    }
    await trx
      .insertInto('job_batches')
      .values({ id: batchId, tenant_id: ctx.tenantId, project_id: project.id, created_by: ctx.actor.id })
      .execute()
    const jobs = await trx
      .insertInto('jobs')
      .values(rows.map((row, i) => ({ ...row, batch_id: batchId, ref: input.jobs[i].ref })))
      .returning(['id', 'ref', 'job_type_id'])
      .execute()
    const idOf = new Map(jobs.map((job) => [job.ref as string, job.id]))
    await trx
      .insertInto('runs')
      .values(
        jobs.map((job) => ({
          tenant_id: ctx.tenantId,
          project_id: project.id,
          job_id: job.id,
          job_type_id: job.job_type_id,
        })),
      )
      .execute()
    const edges = input.jobs.flatMap((job) =>
      // A ref listed twice in depends_on is one edge.
      [...new Set(job.depends_on ?? [])].map((ref) => ({
        tenant_id: ctx.tenantId,
        job_id: idOf.get(job.ref) as string,
        depends_on_job_id: idOf.get(ref) as string,
      })),
    )
    if (edges.length > 0) await trx.insertInto('job_dependencies').values(edges).execute()
    await notifyScheduler(trx, ctx.tenantId)
    return loadBatchView(trx, project.id, batchId)
  })
}

/** A batch of another project or tenant answers DR201 as if it did not exist. */
export async function batchView(ctx: TenantCtx, projectKey: string, batchId: string): Promise<BatchView> {
  if (!isUuid(batchId)) fail('DR201', { kind: 'batch', key: batchId })
  return run(ctx, async (trx) => loadBatchView(trx, (await findProject(trx, projectKey)).id, batchId))
}

async function loadBatchView(trx: Trx, projectId: string, batchId: string): Promise<BatchView> {
  const batch = await trx
    .selectFrom('job_batches')
    .select('id')
    .where('id', '=', batchId)
    .where('project_id', '=', projectId)
    .executeTakeFirst()
  if (!batch) fail('DR201', { kind: 'batch', key: batchId })
  const jobs = await trx
    .selectFrom('jobs as j')
    .innerJoin('job_types as jt', 'jt.id', 'j.job_type_id')
    .innerJoin('runs as r', 'r.job_id', 'j.id')
    .select(['j.id', 'j.ref', 'j.state', 'jt.key as job_type', 'r.id as run_id'])
    .where('j.batch_id', '=', batchId)
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
    id: batch.id,
    jobs: jobs.map((job) => ({
      ref: job.ref as string,
      jobId: job.id,
      runId: job.run_id,
      jobType: job.job_type,
      state: job.state,
    })),
  }
}
